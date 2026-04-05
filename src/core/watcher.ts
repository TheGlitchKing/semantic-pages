import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";

export interface WatcherEvents {
  changed: (paths: string[]) => void;
  error: (error: Error) => void;
}

export class Watcher extends EventEmitter {
  private notesPath: string;
  private fsWatcher: FSWatcher | null = null;
  private debounceMs: number;
  private pendingChanges = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(notesPath: string, debounceMs: number = 500) {
    super();
    this.notesPath = notesPath;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.fsWatcher) return;

    this.fsWatcher = watch("**/*.md", {
      cwd: this.notesPath,
      ignoreInitial: true,
      ignored: [
        "**/node_modules/**",
        "**/.semantic-pages-index/**",
        "**/.git/**",
      ],
    });

    this.fsWatcher.on("add", (path) => this.enqueue(path));
    this.fsWatcher.on("change", (path) => this.enqueue(path));
    this.fsWatcher.on("unlink", (path) => this.enqueue(path));
    this.fsWatcher.on("error", (err) => this.emit("error", err));
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.pendingChanges.clear();
  }

  private enqueue(path: string): void {
    this.pendingChanges.add(path);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const paths = [...this.pendingChanges];
      this.pendingChanges.clear();
      this.emit("changed", paths);
    }, this.debounceMs);
  }
}
