export class ListenableGenerator<T> {
  private _source: AsyncGenerator<T>;
  private _buffer: T[] = [];
  private _listeners: Set<(value: T) => void> = new Set();
  private _isEnded = false;
  private _abortController: AbortController;

  constructor(
    source: AsyncGenerator<T>,
    private readonly onError: (e: any) => void,
    abortController: AbortController,
  ) {
    this._source = source;
    this._abortController = abortController;
    this._start().catch((e) =>
      console.log(`Listenable generator failed: ${e.message}`),
    );
  }

  public cancel() {
    this._abortController.abort();
    this._isEnded = true;
  }

  private async _start() {
    try {
      for await (const value of this._source) {
        if (this._isEnded) {
          break;
        }
        this._buffer.push(value);
        for (const listener of this._listeners) {
          listener(value);
        }
      }
    } catch (e) {
      this.onError(e);
    } finally {
      this._isEnded = true;
      // Notify all listeners that the stream has ended.
      // Use a snapshot to avoid concurrent modification issues.
      const listeners = [...this._listeners];
      for (const listener of listeners) {
        listener(null as any);
      }
    }
  }

  listen(listener: (value: T) => void) {
    this._listeners.add(listener);
    for (const value of this._buffer) {
      listener(value);
    }
    if (this._isEnded) {
      listener(null as any);
    }
  }

  async *tee(): AsyncGenerator<T> {
    let resolveCurrent: ((value: any) => void) | undefined;
    try {
      let i = 0;
      // Drain buffered items first
      while (i < this._buffer.length) {
        yield this._buffer[i++];
      }
      // Wait for new items
      while (!this._isEnded) {
        const promise = new Promise<T>((res) => {
          resolveCurrent = res;
          this._listeners.add(resolveCurrent!);
        });
        await promise;
        if (resolveCurrent) {
          this._listeners.delete(resolveCurrent);
          resolveCurrent = undefined;
        }

        // Drain any items that arrived between promise creation and resolution
        while (i < this._buffer.length) {
          yield this._buffer[i++];
        }
      }
    } finally {
      // Clean up listener if we're still waiting
      if (resolveCurrent) {
        this._listeners.delete(resolveCurrent);
      }
    }
  }
}
