/**
 * Bounded tail buffer (T4.1, extracted for T4.2 reuse) — keeps the LAST
 * `maxBytes` bytes pushed. The completion's `tailBytes` is the END of a
 * command's output, where errors and final results live (D4/R4: only this
 * bounded slice rides the Restate journal; the full stream goes out-of-band).
 *
 * Ported from electric's sandbox output-buffer semantics; shared verbatim by
 * the dev `local`/`local-unrestricted` adapters (host `sh` processes) and the
 * `docker` adapter (`docker exec` client processes) so tail truncation behaves
 * identically across adapters.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const excess = this.bytes - this.maxBytes;
      this.truncated = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
