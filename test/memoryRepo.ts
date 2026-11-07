import type { DemoStore, IntakeEntry } from "../src/core/demo";
import { aggregateStatus } from "../src/core/state";
import type {
  AttemptRecord,
  ClaimedDelivery,
  DeliveryStatus,
  DeliveryUpdate,
  EventDetail,
  EventSummary,
  NewEvent,
  Repository,
} from "../src/core/types";

interface Del {
  id: string;
  eventId: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  replays: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  log: AttemptRecord[];
}

/** In-memory fake of the repository, with the same semantics as the D1 one. */
export class MemoryRepository implements Repository, DemoStore {
  events: NewEvent[] = [];
  deliveries: Del[] = [];
  intake: IntakeEntry[] = [];
  counters = new Map<string, { windowStart: number; hits: number }>();
  private seq = 0;

  async insertEvent(event: NewEvent, destinations: string[]) {
    const existing = this.events.find((e) => e.source === event.source && e.eventKey === event.eventKey);
    if (existing) return { id: existing.id, duplicate: true };
    this.events.push(event);
    for (const destination of destinations) {
      this.deliveries.push({
        id: `d${++this.seq}`,
        eventId: event.id,
        destination,
        status: "pending",
        attempts: 0,
        replays: 0,
        nextAttemptAt: event.receivedAt,
        lastStatusCode: null,
        lastError: null,
        deliveredAt: null,
        log: [],
      });
    }
    return { id: event.id, duplicate: false };
  }

  async claimDue(now: number, limit: number, leaseMs: number, maxAttempts: number): Promise<ClaimedDelivery[]> {
    for (const d of this.deliveries) {
      if (d.status === "pending" && d.nextAttemptAt <= now && d.attempts >= maxAttempts) d.status = "dead";
    }
    const due = this.deliveries
      .filter((d) => d.status === "pending" && d.nextAttemptAt <= now && d.attempts < maxAttempts)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    return due.map((d) => {
      d.attempts += 1;
      d.nextAttemptAt = now + leaseMs;
      const ev = this.events.find((e) => e.id === d.eventId)!;
      return {
        deliveryId: d.id,
        eventId: d.eventId,
        source: ev.source,
        eventKey: ev.eventKey,
        destination: d.destination,
        body: ev.body,
        attempts: d.attempts,
        replays: d.replays,
      };
    });
  }

  async recordAttempt(deliveryId: string, a: AttemptRecord, u: DeliveryUpdate) {
    const d = this.deliveries.find((x) => x.id === deliveryId)!;
    d.log.push(a);
    d.status = u.status;
    d.nextAttemptAt = u.nextAttemptAt;
    d.lastStatusCode = u.lastStatusCode;
    d.lastError = u.lastError;
    d.deliveredAt = u.deliveredAt;
  }

  private summary(e: NewEvent): EventSummary {
    const ds = this.deliveries.filter((d) => d.eventId === e.id);
    return {
      id: e.id,
      source: e.source,
      eventKey: e.eventKey,
      receivedAt: e.receivedAt,
      status: aggregateStatus(ds.map((d) => d.status)),
      deliveries: ds.length,
    };
  }

  async listEvents(q: { status?: DeliveryStatus; limit: number; offset: number }) {
    return this.events
      .map((e) => this.summary(e))
      .filter((s) => !q.status || s.status === q.status)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(q.offset, q.offset + q.limit);
  }

  async getEvent(id: string): Promise<EventDetail | null> {
    const e = this.events.find((x) => x.id === id);
    if (!e) return null;
    const deliveryList = this.deliveries
      .filter((d) => d.eventId === id)
      .map((d) => ({ ...d, attemptLog: d.log }));
    return { ...this.summary(e), body: e.body, deliveryList };
  }

  async replayEvent(id: string, now: number) {
    if (!this.events.some((e) => e.id === id)) return null;
    let n = 0;
    for (const d of this.deliveries) {
      if (d.eventId === id && (d.status === "failed" || d.status === "dead")) {
        d.status = "pending";
        d.attempts = 0;
        d.replays += 1;
        d.nextAttemptAt = now;
        d.lastError = null;
        d.lastStatusCode = null;
        n++;
      }
    }
    return n;
  }

  async hitCounter(key: string, windowStart: number, by = 1) {
    const c = this.counters.get(key) ?? { windowStart, hits: 0 };
    c.hits += by;
    this.counters.set(key, c);
    return c.hits;
  }

  async purgeCounters(olderThan: number) {
    for (const [k, c] of this.counters) if (c.windowStart < olderThan) this.counters.delete(k);
  }

  async countEvents() {
    return this.events.length;
  }

  private remove(ids: Set<string>) {
    this.events = this.events.filter((e) => !ids.has(e.id));
    this.deliveries = this.deliveries.filter((d) => !ids.has(d.eventId));
    return ids.size;
  }

  async purgeEventsBefore(cutoffMs: number) {
    return this.remove(new Set(this.events.filter((e) => e.receivedAt < cutoffMs).map((e) => e.id)));
  }

  async trimEventsTo(keep: number) {
    const sorted = [...this.events].sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id));
    return this.remove(new Set(sorted.slice(keep).map((e) => e.id)));
  }

  async logIntake(e: Omit<IntakeEntry, "id">) {
    this.intake.push({ ...e, id: this.intake.length + 1 });
  }

  async listIntake(limit: number) {
    return [...this.intake].sort((a, b) => b.receivedAt - a.receivedAt || b.id - a.id).slice(0, limit);
  }

  async purgeIntakeBefore(cutoffMs: number) {
    this.intake = this.intake.filter((e) => e.receivedAt >= cutoffMs);
  }

  async trimIntakeTo(keep: number) {
    this.intake = (await this.listIntake(keep)).reverse();
  }
}
