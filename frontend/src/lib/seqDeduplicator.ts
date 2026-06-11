/**
 * Set-based sequence deduplicator for WebSocket event streams.
 *
 * acp-client stamps every streamed event with a monotonically increasing
 * `seq`; events can arrive duplicated across reconnects. Each event TYPE gets
 * its own instance so a tool event with seq=5 doesn't cause a chunk with
 * seq=4 to be dropped.
 *
 * Extracted from useAgentStatus (plan §6) so the discussion assist stream
 * shares the exact same dedupe semantics.
 */
export class SeqDeduplicator {
  private seen = new Set<number>();
  private maxSeen = 0;

  /** Returns true if this seq should be processed (not a duplicate). */
  accept(seq: number | null | undefined): boolean {
    if (seq == null) return true; // No seq = always accept
    if (this.seen.has(seq)) return false;
    this.seen.add(seq);
    this.maxSeen = Math.max(this.maxSeen, seq);
    if (this.seen.size > 1000) {
      // prune, keep last 500
      const cutoff = this.maxSeen - 500;
      for (const s of this.seen) {
        if (s < cutoff) this.seen.delete(s);
      }
    }
    return true;
  }

  reset() {
    this.seen.clear();
    this.maxSeen = 0;
  }
}
