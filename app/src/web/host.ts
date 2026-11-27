/** What differs between the web page and the desktop app: opening and saving `.wiret` files.
 *
 * The page code is the same in both. In the browser, files are opened and saved with the File
 * System Access API where the browser has it, else an <input type=file> and a download. In the
 * Tauri desktop app, with the native open and save dialogs and the file system plugin; the
 * file is also watched, so a change made by another program (an LLM, `git checkout`, another
 * editor) is loaded, as the desktop prototype did. */

export interface HostPage {
  getText(): string;
  setText(text: string, path: string | null): void;
  say(text: string, error?: boolean): void;
}

/** The student's copies of the lessons, kept in ~/Documents/Wiret/my_lessons as the desktop
 *  prototype keeps them. A lesson is named by its file name, such as `01_hello.wiret`. */
export interface LessonStore {
  /** The student's copy of a lesson, or null if they have not changed it. */
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  /** Delete the copies of these lessons; anything else in the folder stays. Returns how many. */
  remove(names: string[]): Promise<number>;
}

interface Host {
  name: string;
  init(page: HostPage): Promise<void>;
  /** The page loaded a text: a file at `path`, or a lesson (null). */
  opened(path: string | null): void;
  /** Where lesson changes are kept, if this host keeps them (the desktop app does). */
  lessons: LessonStore | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function addButtons(open: () => void, save: () => void, saveAs: () => void): void {
  const bar = document.querySelector("header .group");
  const mk = (id: string, text: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = text;
    b.title = title;
    b.onclick = fn;
    return b;
  };
  const group = document.createElement("div");
  group.className = "group";
  group.setAttribute("role", "toolbar");
  group.setAttribute("aria-label", "File");
  group.append(mk("open", "Open…", "Open a .wiret file (Ctrl+O)", open), mk("save", "Save", "Save the program (Ctrl+S)", save),
               mk("saveas", "Save as…", "Save the program to a new file (Ctrl+Shift+S)", saveAs));
  bar?.parentElement?.insertBefore(group, bar);
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); open(); }
    else if (k === "s" && e.shiftKey) { e.preventDefault(); saveAs(); }
    else if (k === "s") { e.preventDefault(); save(); }
  });
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function setTitle(path: string | null): void {
  document.title = path ? `${baseName(path)} — Wiret` : "Wiret";
}

// -- the browser -----------------------------------------------------------------------
type FileHandle = { name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(t: string): Promise<void>; close(): Promise<void> }> };
const pickerOpts = { types: [{ description: "Wiret program", accept: { "text/plain": [".wiret"] } }] };

function webHost(): Host {
  let page!: HostPage;
  let handle: FileHandle | null = null;
  let current: string | null = null;
  const w = window as any;
  const open = async () => {
    try {
      if (w.showOpenFilePicker) {
        const [h] = await w.showOpenFilePicker(pickerOpts);
        const text = await (await h.getFile()).text();
        page.setText(text, h.name);
        handle = h;
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".wiret,text/plain";
      input.onchange = async () => {
        const f = input.files?.[0];
        if (f) page.setText(await f.text(), f.name);
      };
      input.click();
    } catch (e) {
      if ((e as Error).name !== "AbortError") page.say(`Could not open the file: ${e}`, true);
    }
  };
  const write = async (h: FileHandle) => {
    const s = await h.createWritable();
    await s.write(page.getText());
    await s.close();
    page.say(`Saved ${h.name}.`);
  };
  const saveAs = async () => {
    try {
      if (w.showSaveFilePicker) {
        const h = await w.showSaveFilePicker({ ...pickerOpts, suggestedName: current ?? "program.wiret" });
        await write(h);
        handle = h;
        current = h.name;
        setTitle(current);
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([page.getText()], { type: "text/plain" }));
      a.download = current ?? "program.wiret";
      a.click();
      URL.revokeObjectURL(a.href);
      page.say(`Downloaded ${a.download}.`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") page.say(`Could not save the file: ${e}`, true);
    }
  };
  const save = async () => {
    if (!handle) return saveAs();
    try {
      await write(handle);
    } catch (e) {
      page.say(`Could not save the file: ${e}`, true);
    }
  };
  return {
    name: "Wiret in the browser",
    async init(p) {
      page = p;
      addButtons(open, save, saveAs);
    },
    lessons: null,
    opened(path) {
      if (path === null) handle = null;
      current = path;
      setTitle(path);
    },
  };
}

// -- the Tauri desktop app ---------------------------------------------------------------
function tauriHost(): Host {
  let page!: HostPage;
  let path: string | null = null;
  let saved: string | null = null;       // the file's text as last read or written
  let unwatch: (() => void) | null = null;
  let fs: typeof import("@tauri-apps/plugin-fs");
  let dialog: typeof import("@tauri-apps/plugin-dialog");
  const filters = [{ name: "Wiret program", extensions: ["wiret"] }];

  const watch = async (p: string) => {
    unwatch?.();
    unwatch = null;
    try {
      unwatch = await fs.watch(p, async () => {
        let text: string;
        try {
          text = await fs.readTextFile(p);
        } catch {
          return;
        }
        if (p !== path || text === saved) return;
        saved = text;
        page.setText(text, p);
        page.say(`${baseName(p)} was changed by another program, so it was loaded again.`);
      }, { delayMs: 300 });
    } catch (e) {
      console.warn("cannot watch", p, e);
    }
  };
  const openPath = async (p: string) => {
    const text = await fs.readTextFile(p);
    saved = text;
    page.setText(text, p);
    await watch(p);
  };
  const open = async () => {
    try {
      const p = await dialog.open({ multiple: false, directory: false, filters });
      if (typeof p === "string") await openPath(p);
    } catch (e) {
      page.say(`Could not open the file: ${e}`, true);
    }
  };
  const writeTo = async (p: string) => {
    const text = page.getText();
    saved = text;
    await fs.writeTextFile(p, text);
    page.say(`Saved ${baseName(p)}.`);
  };
  const saveAs = async () => {
    try {
      const p = await dialog.save({ filters, defaultPath: path ?? "program.wiret" });
      if (!p) return;
      await writeTo(p);
      path = p;
      setTitle(p);
      await watch(p);
    } catch (e) {
      page.say(`Could not save the file: ${e}`, true);
    }
  };
  const save = async () => {
    if (!path) return saveAs();
    try {
      await writeTo(path);
    } catch (e) {
      page.say(`Could not save the file: ${e}`, true);
    }
  };
  const call = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    name: "Wiret desktop",
    lessons: {
      read: (name) => call<string | null>("read_lesson_copy", { name }),
      write: (name, text) => call<void>("write_lesson_copy", { name, text }),
      remove: (names) => call<number>("remove_lesson_copies", { names }),
    },
    async init(p) {
      page = p;
      fs = await import("@tauri-apps/plugin-fs");
      dialog = await import("@tauri-apps/plugin-dialog");
      addButtons(open, save, saveAs);
      const { invoke } = await import("@tauri-apps/api/core");
      const arg = await invoke<string | null>("startup_file").catch(() => null);
      if (arg) queueMicrotask(() => openPath(arg).catch((e) => page.say(`Could not open ${arg}: ${e}`, true)));
    },
    opened(p) {
      if (p !== path) {
        unwatch?.();
        unwatch = null;
      }
      path = p;
      if (p === null) saved = null;
      setTitle(p);
    },
  };
}

export const host: Host = isTauri ? tauriHost() : webHost();
