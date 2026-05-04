export type AdmitResult =
  | { ok: true }
  | { ok: false; shouldNotify: boolean };

export class IdentityGate {
  private readonly allowed: Set<string>;
  private readonly rejectCooldownMs: number;
  private lastReject = new Map<string, number>();

  constructor(opts: { allowed: string[]; rejectCooldownMs: number }) {
    this.allowed = new Set(opts.allowed);
    this.rejectCooldownMs = opts.rejectCooldownMs;
  }

  admit(userId: string, nowMs: number): AdmitResult {
    if (this.allowed.has(userId)) return { ok: true };
    const last = this.lastReject.get(userId) ?? -Infinity;
    const cooled = nowMs - last >= this.rejectCooldownMs;
    if (cooled) this.lastReject.set(userId, nowMs);
    return { ok: false, shouldNotify: cooled };
  }
}
