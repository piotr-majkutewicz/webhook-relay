import type { DemoStore, IntakeEntry } from "./core/demo";
import { aggregateStatus } from "./core/state";
import type {
  AttemptRecord,
  ClaimedDelivery,
  DeliveryStatus,
  DeliveryUpdate,
  DeliveryView,
  EventDetail,
  EventSummary,
  NewEvent,
  Repository,
} from "./core/types";

interface DeliveryRow {
  id: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  replays: number;
  next_attempt_at: number;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: number | null;
}

export class D1Repository implements Repository, DemoStore {
  constructor(private readonly db: D1Database) {}

  async insertEvent(event: NewEvent, destinations: string[]): Promise<{ id: string; duplicate: boolean }> {
    // One transaction (D1 batch). If the event row is ignored because of the
    // unique (source, event_key) index, the deliveries are skipped too: their
    // INSERT ... SELECT only fires when our freshly generated id exists.
    const stmts = [
      this.db
        .prepare(
          "INSERT INTO events (id, source, event_key, body, received_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (source, event_key) DO NOTHING",
        )
        .bind(event.id, event.source, event.eventKey, event.body, event.receivedAt),
      ...destinations.map((dest) =>
        this.db
          .prepare(
            `INSERT INTO deliveries (id, event_id, destination, status, next_attempt_at, created_at, updated_at)
             SELECT ?1, ?2, ?3, 'pending', ?4, ?4, ?4 WHERE EXISTS (SELECT 1 FROM events WHERE id = ?2)`,
          )
          .bind(crypto.randomUUID(), event.id, dest, event.receivedAt),
      ),
    ];
    const results = await this.db.batch(stmts);
    if ((results[0]?.meta.changes ?? 0) > 0) return { id: event.id, duplicate: false };

    const existing = await this.db
      .prepare("SELECT id FROM events WHERE source = ?1 AND event_key = ?2")
      .bind(event.source, event.eventKey)
      .first<{ id: string }>();
    return { id: existing?.id ?? event.id, duplicate: true };
  }

  async claimDue(now: number, limit: number, leaseMs: number, maxAttempts: number): Promise<ClaimedDelivery[]> {
    // A delivery whose final attempt was claimed but never recorded (worker
    // crashed or was evicted) would never be picked up again: bury it.
    await this.db
      .prepare(
        `UPDATE deliveries SET status = 'dead', last_error = 'lease expired after final attempt', updated_at = ?1
         WHERE status = 'pending' AND next_attempt_at <= ?1 AND attempts >= ?2`,
      )
      .bind(now, maxAttempts)
      .run();

    // Single atomic statement: select due rows, push next_attempt_at forward
    // (the lease) and count the attempt. A concurrent run cannot claim the same rows.
    const { results } = await this.db
      .prepare(
        `UPDATE deliveries
            SET attempts = attempts + 1, next_attempt_at = ?2, updated_at = ?1
          WHERE id IN (
            SELECT id FROM deliveries
             WHERE status = 'pending' AND next_attempt_at <= ?1 AND attempts < ?4
             ORDER BY next_attempt_at LIMIT ?3)
        RETURNING id, event_id, destination, attempts, replays`,
      )
      .bind(now, now + leaseMs, limit, maxAttempts)
      .all<{ id: string; event_id: string; destination: string; attempts: number; replays: number }>();

    const out: ClaimedDelivery[] = [];
    for (const r of results) {
      const ev = await this.db
        .prepare("SELECT source, event_key, body FROM events WHERE id = ?1")
        .bind(r.event_id)
        .first<{ source: string; event_key: string; body: string }>();
      if (!ev) continue;
      out.push({
        deliveryId: r.id,
        eventId: r.event_id,
        source: ev.source,
        eventKey: ev.event_key,
        destination: r.destination,
        body: ev.body,
        attempts: r.attempts,
        replays: r.replays,
      });
    }
    return out;
  }

  async recordAttempt(deliveryId: string, a: AttemptRecord, u: DeliveryUpdate): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO attempts (delivery_id, attempt_no, replay_no, started_at, duration_ms, outcome, status_code, error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .bind(deliveryId, a.attemptNo, a.replayNo, a.startedAt, a.durationMs, a.outcome, a.statusCode, a.error),
      this.db
        .prepare(
          `UPDATE deliveries SET status = ?2, next_attempt_at = ?3, last_status_code = ?4, last_error = ?5,
                  delivered_at = ?6, updated_at = ?7 WHERE id = ?1`,
        )
        .bind(deliveryId, u.status, u.nextAttemptAt, u.lastStatusCode, u.lastError, u.deliveredAt, a.startedAt + a.durationMs),
    ]);
  }

  async listEvents(q: { status?: DeliveryStatus; limit: number; offset: number }): Promise<EventSummary[]> {
    // Keep this CASE in sync with aggregateStatus() in core/state.ts.
    const sql = `
      SELECT * FROM (
        SELECT e.id, e.source, e.event_key, e.received_at, COUNT(d.id) AS deliveries,
               CASE WHEN SUM(d.status = 'dead') > 0 THEN 'dead'
                    WHEN SUM(d.status = 'failed') > 0 THEN 'failed'
                    WHEN SUM(d.status = 'pending') > 0 THEN 'pending'
                    ELSE 'delivered' END AS status
          FROM events e LEFT JOIN deliveries d ON d.event_id = e.id
         GROUP BY e.id)
       WHERE (?1 IS NULL OR status = ?1)
       ORDER BY received_at DESC, id LIMIT ?2 OFFSET ?3`;
    const { results } = await this.db
      .prepare(sql)
      .bind(q.status ?? null, q.limit, q.offset)
      .all<{ id: string; source: string; event_key: string; received_at: number; deliveries: number; status: DeliveryStatus }>();
    return results.map((r) => ({
      id: r.id,
      source: r.source,
      eventKey: r.event_key,
      receivedAt: r.received_at,
      status: r.status,
      deliveries: r.deliveries,
    }));
  }

  async getEvent(id: string): Promise<EventDetail | null> {
    const ev = await this.db
      .prepare("SELECT id, source, event_key, body, received_at FROM events WHERE id = ?1")
      .bind(id)
      .first<{ id: string; source: string; event_key: string; body: string; received_at: number }>();
    if (!ev) return null;

    const { results: drows } = await this.db
      .prepare(
        "SELECT id, destination, status, attempts, replays, next_attempt_at, last_status_code, last_error, delivered_at FROM deliveries WHERE event_id = ?1 ORDER BY destination",
      )
      .bind(id)
      .all<DeliveryRow>();

    const deliveryList: DeliveryView[] = [];
    for (const d of drows) {
      const { results: arows } = await this.db
        .prepare(
          "SELECT attempt_no, replay_no, started_at, duration_ms, outcome, status_code, error FROM attempts WHERE delivery_id = ?1 ORDER BY id",
        )
        .bind(d.id)
        .all<{
          attempt_no: number;
          replay_no: number;
          started_at: number;
          duration_ms: number;
          outcome: AttemptRecord["outcome"];
          status_code: number | null;
          error: string | null;
        }>();
      deliveryList.push({
        id: d.id,
        destination: d.destination,
        status: d.status,
        attempts: d.attempts,
        replays: d.replays,
        nextAttemptAt: d.next_attempt_at,
        lastStatusCode: d.last_status_code,
        lastError: d.last_error,
        deliveredAt: d.delivered_at,
        attemptLog: arows.map((a) => ({
          attemptNo: a.attempt_no,
          replayNo: a.replay_no,
          startedAt: a.started_at,
          durationMs: a.duration_ms,
          outcome: a.outcome,
          statusCode: a.status_code,
          error: a.error,
        })),
      });
    }
    return {
      id: ev.id,
      source: ev.source,
      eventKey: ev.event_key,
      receivedAt: ev.received_at,
      body: ev.body,
      status: aggregateStatus(deliveryList.map((d) => d.status)),
      deliveries: deliveryList.length,
      deliveryList,
    };
  }

  async replayEvent(id: string, now: number): Promise<number | null> {
    const ev = await this.db.prepare("SELECT 1 AS x FROM events WHERE id = ?1").bind(id).first();
    if (!ev) return null;
    const res = await this.db
      .prepare(
        `UPDATE deliveries SET status = 'pending', attempts = 0, replays = replays + 1, next_attempt_at = ?2,
                last_error = NULL, last_status_code = NULL, updated_at = ?2
          WHERE event_id = ?1 AND status IN ('failed', 'dead')`,
      )
      .bind(id, now)
      .run();
    return res.meta.changes ?? 0;
  }

  // ---- DEMO_MODE support: rate counters and retention ----

  async hitCounter(key: string, windowStart: number): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO demo_rate_counters (key, window_start, hits) VALUES (?1, ?2, 1)
         ON CONFLICT (key) DO UPDATE SET hits = hits + 1 RETURNING hits`,
      )
      .bind(key, windowStart)
      .first<{ hits: number }>();
    return row?.hits ?? Number.MAX_SAFE_INTEGER; // fail closed
  }

  async purgeCounters(olderThanWindowStart: number): Promise<void> {
    await this.db.prepare("DELETE FROM demo_rate_counters WHERE window_start < ?1").bind(olderThanWindowStart).run();
  }

  async countEvents(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Children are deleted explicitly (in one transaction) so this does not depend on foreign key enforcement. */
  private deleteEventsWhere(idsSql: string, binds: unknown[]): Promise<number> {
    return this.db
      .batch([
        this.db
          .prepare(`DELETE FROM attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE event_id IN (${idsSql}))`)
          .bind(...binds),
        this.db.prepare(`DELETE FROM deliveries WHERE event_id IN (${idsSql})`).bind(...binds),
        this.db.prepare(`DELETE FROM events WHERE id IN (${idsSql})`).bind(...binds),
      ])
      .then((r) => r[2]?.meta.changes ?? 0);
  }

  purgeEventsBefore(cutoffMs: number): Promise<number> {
    return this.deleteEventsWhere("SELECT id FROM events WHERE received_at < ?1", [cutoffMs]);
  }

  trimEventsTo(keep: number): Promise<number> {
    return this.deleteEventsWhere("SELECT id FROM events ORDER BY received_at DESC, id LIMIT -1 OFFSET ?1", [keep]);
  }

  async logIntake(e: Omit<IntakeEntry, "id">): Promise<void> {
    await this.db
      .prepare("INSERT INTO demo_intake_log (received_at, kind, reason, event_id, event_key) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(e.receivedAt, e.kind, e.reason, e.eventId, e.eventKey)
      .run();
  }

  async listIntake(limit: number): Promise<IntakeEntry[]> {
    const { results } = await this.db
      .prepare("SELECT id, received_at, kind, reason, event_id, event_key FROM demo_intake_log ORDER BY received_at DESC, id DESC LIMIT ?1")
      .bind(limit)
      .all<{ id: number; received_at: number; kind: IntakeEntry["kind"]; reason: string; event_id: string | null; event_key: string | null }>();
    return results.map((r) => ({
      id: r.id,
      receivedAt: r.received_at,
      kind: r.kind,
      reason: r.reason,
      eventId: r.event_id,
      eventKey: r.event_key,
    }));
  }

  async purgeIntakeBefore(cutoffMs: number): Promise<void> {
    await this.db.prepare("DELETE FROM demo_intake_log WHERE received_at < ?1").bind(cutoffMs).run();
  }

  async trimIntakeTo(keep: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM demo_intake_log WHERE id IN (SELECT id FROM demo_intake_log ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?1)")
      .bind(keep)
      .run();
  }
}
