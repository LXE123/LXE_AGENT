const clean = (value: unknown): string => String(value ?? "").trim();

export class SessionRuntimeState {
  private readonly steeringEnabled = new Set<string>();
  private readonly autonomySuspended = new Set<string>();

  isSteeringEnabled(sessionId: string): boolean {
    return this.steeringEnabled.has(clean(sessionId));
  }

  setSteering(sessionId: string, enabled: boolean): void {
    const safe = clean(sessionId);
    if (!safe) return;
    if (enabled) this.steeringEnabled.add(safe);
    else this.steeringEnabled.delete(safe);
  }

  toggleSteering(sessionId: string): boolean {
    const safe = clean(sessionId);
    if (!safe) return false;
    const enabled = !this.steeringEnabled.has(safe);
    this.setSteering(safe, enabled);
    return enabled;
  }

  suspendAutonomy(sessionId: string): void {
    const safe = clean(sessionId);
    if (safe) this.autonomySuspended.add(safe);
  }

  resumeAutonomy(sessionId: string): boolean {
    return this.autonomySuspended.delete(clean(sessionId));
  }

  isAutonomySuspended(sessionId: string): boolean {
    return this.autonomySuspended.has(clean(sessionId));
  }
}
