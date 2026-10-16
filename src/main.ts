import {
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  moment,
  normalizePath,
  parseYaml,
} from "obsidian";
import { ContentBlock, callClaude } from "./claude";
import {
  COVER_PHOTO_PROMPT,
  DAILY_REPLY_PROMPT,
  MEMORY_UPDATE_PROMPT,
  MOOD_PROMPT,
  moodLanguageRule,
  MONTHLY_SUMMARY_PROMPT,
  WEEKLY_SUMMARY_PROMPT,
  YEARLY_SUMMARY_PROMPT,
} from "./prompts";
import { CompanionSettingTab, DEFAULT_SETTINGS, JournalCompanionSettings } from "./settings";
import {
  CalendarDay,
  Mood,
  addAnswerSlots,
  arrangePhotos,
  calendarMarkdown,
  extractQuestions,
  feelingsInLanguage,
  hasAnswers,
  isImagePath,
  parseChoice,
  parseLink,
  isInside,
  monthFolderTarget,
  MoodRow,
  activeDelta,
  moodEmoji,
  moodSection,
  parseMoodJson,
  toMood,
  buildMemoryNote,
  splitMemory,
  stripFrontmatter,
  countWords,
  extractDate,
  formatStatsLine,
  hasReply,
  isMostlyCJK,
  stripReplies,
  toCallout,
  truncate,
} from "./utils";

// Obsidian re-exports moment, but its typings aren't callable under TS 5.x.
const mo = moment as unknown as (...args: unknown[]) => moment.Moment;

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;
const WEEK_KEY = "GGGG-[W]WW"; // ISO week, e.g. 2026-W39
const TYPING_IDLE_GAP_MS = 2 * 60 * 1000;
const STATS_SAVE_MS = 30 * 1000;

type SummaryKind = "Weekly" | "Monthly" | "Yearly";

interface Entry {
  file: TFile;
  date: moment.Moment;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export default class JournalCompanion extends Plugin {
  settings!: JournalCompanionSettings;

  /** Prevents overlapping catch-up runs. */
  private busy = false;
  /** Last edit time per journal file, used for the idle auto-reply. */
  private lastEdit = new Map<string, number>();
  /** Files currently being replied to, to avoid double replies. */
  private replying = new Set<string>();
  /** "Reply" buttons added to note headers, keyed by view. */
  private headerButtons = new Map<MarkdownView, HTMLElement>();
  /** Last keystroke per journal file, for measuring active writing time. */
  private lastKeystroke = new Map<string, number>();
  private statsDirty = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CompanionSettingTab(this.app, this));

    this.addRibbonIcon("heart", "Reply to this journal entry", () => this.replyToActive(false));

    this.addCommand({
      id: "reply-current",
      name: "Reply to the current journal entry",
      callback: () => this.replyToActive(false),
    });
    this.addCommand({
      id: "rewrite-reply-current",
      name: "Regenerate the reply for the current entry",
      callback: () => this.replyToActive(true),
    });
    this.addCommand({
      id: "summarize-week-current",
      name: "Generate or refresh the weekly summary for the current entry's week",
      callback: () => this.summarizeWeekOfActive(),
    });
    this.addCommand({
      id: "summarize-month-current",
      name: "Generate or refresh the monthly summary for the current entry's month",
      callback: () => this.summarizeMonthOfActive(),
    });
    this.addCommand({
      id: "update-memory",
      name: "Update long-term memory from the last 7 days",
      callback: () => this.updateMemoryFromRecent(),
    });
    this.addCommand({
      id: "open-memory",
      name: "Open the long-term memory note",
      callback: () => this.app.workspace.openLinkText(normalizePath(this.settings.memoryPath), "", true),
    });
    this.addCommand({
      id: "open-mood",
      name: "Open the mood & energy chart (last 30 days)",
      callback: async () => {
        await this.refreshMoodNote();
        await this.app.workspace.openLinkText(this.moodNotePath(), "", true);
      },
    });
    this.addCommand({
      id: "rescore-mood-current",
      name: "Re-score mood and energy for the current entry",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        const entry = f && this.getEntries().find((e) => e.file.path === f.path);
        if (!entry) return new Notice("Open a journal entry first.");
        try {
          const m = await this.scoreEntry(entry, true);
          new Notice(m ? `Mood ${m.mood}/5 · Energy ${m.energy}/5 · ${m.emotions.join(", ")}` : "Couldn't score this entry.");
        } catch (e) {
          new Notice(`Scoring failed: ${(e as Error).message}`, 10000);
        }
      },
    });
    this.addCommand({
      id: "organize-by-month",
      name: "Organize past entries into monthly folders now",
      callback: async () => {
        const n = await this.organizeEntries();
        new Notice(n ? `📁 Moved ${n} ${n === 1 ? "entry" : "entries"} into monthly folders.` : "📁 Everything is already in place.");
      },
    });
    this.addCommand({
      id: "arrange-photos-current",
      name: "Arrange photos in the current entry into a grid",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !this.isJournal(f)) return new Notice("Open a journal entry first.");
        new Notice((await this.arrangeEntryPhotos(f)) ? "📷 Photos arranged." : "📷 No runs of two or more photos to arrange.");
      },
    });
    this.addCommand({
      id: "open-calendar",
      name: "Open this month's photo calendar",
      callback: async () => {
        const name = await this.refreshCalendar(mo().format("YYYY-MM"));
        await this.app.workspace.openLinkText(name, "", true);
      },
    });
    this.addCommand({
      id: "choose-cover-current",
      name: "Choose a new cover photo for the current entry",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        const entry = f && this.getEntries().find((e) => e.file.path === f.path);
        if (!entry) return new Notice("Open a journal entry first.");
        try {
          new Notice((await this.chooseCover(entry, true)) ? "🖼️ Cover photo updated." : "This entry has no photos.");
        } catch (e) {
          new Notice(`Choosing a cover failed: ${(e as Error).message}`, 10000);
        }
      },
    });
    this.addCommand({
      id: "catch-up",
      name: "Catch up now: missing replies and summaries",
      callback: () => this.runChecks(true),
    });

    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && this.isJournal(f)) this.lastEdit.set(f.path, Date.now());
      })
    );

    // Measure active writing time: sum the gaps between keystrokes,
    // ignoring pauses long enough to mean the writer stepped away.
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info: MarkdownView | MarkdownFileInfo) => {
        if (info.file) this.trackTyping(info.file);
      })
    );
    this.registerInterval(
      window.setInterval(() => {
        if (this.statsDirty) {
          this.statsDirty = false;
          this.saveSettings();
        }
      }, STATS_SAVE_MS)
    );

    // A visible "reply" button in the header of every journal note. The
    // ribbon icon alone was too easy to miss.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshHeaderButtons()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshHeaderButtons()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshHeaderButtons()));

    this.app.workspace.onLayoutReady(() => {
      this.refreshHeaderButtons();
      window.setTimeout(() => this.runChecks(false), 5000);
    });
    this.registerInterval(window.setInterval(() => this.runChecks(false), CHECK_INTERVAL_MS));
    this.registerInterval(window.setInterval(() => this.checkIdleToday(), IDLE_POLL_MS));
  }

  onunload() {
    if (this.statsDirty) this.saveSettings();
    for (const el of this.headerButtons.values()) el.remove();
    this.headerButtons.clear();
  }

  /** Shows the header reply button on journal notes and hides it elsewhere. */
  refreshHeaderButtons() {
    const open = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      open.add(view);
      let btn = this.headerButtons.get(view);
      if (!btn) {
        btn = view.addAction("heart", "Get a letter from Claude for this entry", () => {
          if (view.file) this.replyToFile(view.file, false);
        });
        this.headerButtons.set(view, btn);
      }
      btn.toggle(!!view.file && this.isJournal(view.file));
    }
    // Forget views that have been closed.
    for (const view of [...this.headerButtons.keys()]) {
      if (!open.has(view)) this.headerButtons.delete(view);
    }
  }

  trackTyping(file: TFile) {
    if (!this.isJournal(file)) return;
    const date = extractDate(file.basename)!;
    const now = Date.now();
    const delta = activeDelta(this.lastKeystroke.get(file.path), now, TYPING_IDLE_GAP_MS);
    this.lastKeystroke.set(file.path, now);
    if (delta > 0) {
      this.settings.writingTime[date] = (this.settings.writingTime[date] ?? 0) + delta;
      this.statsDirty = true;
    }
  }

  /** Stats line for an entry: days journaled and words written up to it. */
  async statsLineFor(entry: Entry, all: Entry[], text: string): Promise<string> {
    const upToNow = all.filter((e) => !e.date.isAfter(entry.date, "day"));
    let totalWords = 0;
    for (const e of upToNow) totalWords += countWords(await this.readEntry(e));
    return formatStatsLine({
      name: this.settings.yourName,
      days: upToNow.length,
      totalWords,
      words: countWords(text),
      activeMs: this.settings.writingTime[entry.date.format("YYYY-MM-DD")],
      chinese: isMostlyCJK(text),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.writingTime = { ...(this.settings.writingTime ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Thin wrapper so the settings tab can test the connection. */
  ask(model: string, system: string, user: string | ContentBlock[], maxTokens: number): Promise<string> {
    return callClaude({ apiKey: this.settings.apiKey, model, system, user, maxTokens });
  }

  // ---------------------------------------------------------------------------
  // Journal discovery
  // ---------------------------------------------------------------------------

  isJournal(f: TFile): boolean {
    // Entries may sit directly in the journal folder or in any subfolder
    // (e.g. monthly folders), but never in the summaries folder.
    return (
      f.extension === "md" &&
      isInside(f.path, normalizePath(this.settings.journalFolder)) &&
      !isInside(f.path, normalizePath(this.settings.summaryFolder)) &&
      extractDate(f.basename) !== null
    );
  }

  /** All journal entries in the journal folder and its subfolders, oldest first. */
  getEntries(): Entry[] {
    const entries: Entry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isJournal(file)) continue;
      const date = mo(extractDate(file.basename), "YYYY-MM-DD", true);
      if (date.isValid()) entries.push({ file, date });
    }
    return entries.sort((a, b) => a.date.valueOf() - b.date.valueOf());
  }

  /**
   * Moves entries from before today into their month folder. Uses
   * fileManager.renameFile so links to the entry are updated. Never touches
   * today's entry, and never overwrites an existing file.
   */
  async organizeEntries(): Promise<number> {
    const today = mo().startOf("day");
    let moved = 0;
    for (const e of this.getEntries()) {
      if (!e.date.isBefore(today)) continue;
      const target = normalizePath(
        monthFolderTarget(this.settings.journalFolder, e.date.format(this.settings.monthFolderFormat), e.file.name)
      );
      if (e.file.path === target || this.app.vault.getAbstractFileByPath(target)) continue;
      await this.ensureFolder(target.substring(0, target.lastIndexOf("/")));
      await this.app.fileManager.renameFile(e.file, target);
      moved++;
    }
    return moved;
  }

  /** Entry text with any previous AI replies removed. */
  async readEntry(e: Entry): Promise<string> {
    return stripFrontmatter(stripReplies(await this.app.vault.cachedRead(e.file)));
  }

  async entryHasReply(f: TFile): Promise<boolean> {
    return hasReply(await this.app.vault.cachedRead(f));
  }

  // ---------------------------------------------------------------------------
  // Daily replies
  // ---------------------------------------------------------------------------

  /** Writes a reply for one entry. Returns true if a reply was appended. */
  async replyTo(entry: Entry, all: Entry[], force = false): Promise<boolean> {
    const f = entry.file;
    if (this.replying.has(f.path)) return false;
    if (!force && (await this.entryHasReply(f))) return false;

    const text = await this.readEntry(entry);
    if (text.length < 20) return false; // Too short to reply to meaningfully.

    this.replying.add(f.path);
    try {
      // Previous entries (within a week) as background for continuity.
      const idx = all.findIndex((e) => e.file.path === f.path);
      const previous = all
        .slice(Math.max(0, idx - this.settings.contextDays), Math.max(0, idx))
        .filter((e) => entry.date.diff(e.date, "days") <= 7);

      let user = "";
      const memory = await this.readMemory();
      if (memory) user += `[Long-term memory about the writer — background only]\n${truncate(memory, 4000)}\n\n`;
      if (previous.length) {
        user += "[Earlier entries — background only]\n";
        for (const p of previous) {
          user += `--- ${p.date.format("YYYY-MM-DD ddd")} ---\n${truncate(await this.readEntry(p), 1500)}\n\n`;
        }
      }
      user += `[Today's entry to reply to: ${entry.date.format("YYYY-MM-DD ddd")}]\n${truncate(text)}`;

      let system = DAILY_REPLY_PROMPT;
      const extra = this.settings.extraStyle.trim();
      if (extra) system += `\n\nAdditional instructions from the writer: ${extra}`;

      const reply = await this.ask(this.settings.dailyModel, system, user, 1000);
      if (!reply) return false;

      const stats = this.settings.showStats ? await this.statsLineFor(entry, all, text) : undefined;

      // vault.process is atomic, so a concurrent edit can't be overwritten.
      await this.app.vault.process(f, (content) => {
        const base = force ? stripReplies(content) : content.trimEnd();
        return base + toCallout(reply, mo().format("YYYY-MM-DD HH:mm"), stats);
      });

      if (this.settings.trackMood) {
        try {
          await this.scoreEntry(entry, force);
        } catch (e) {
          console.error("[journal-companion] mood scoring failed", e); // Never block a letter on this.
        }
      }
      return true;
    } finally {
      this.replying.delete(f.path);
    }
  }

  async replyToActive(force: boolean) {
    const f = this.app.workspace.getActiveFile();
    if (f) await this.replyToFile(f, force);
    else new Notice(`Open a journal entry in "${this.settings.journalFolder}" first.`);
  }

  async replyToFile(f: TFile, force: boolean) {
    if (!this.isJournal(f)) {
      new Notice(`Open a journal entry in "${this.settings.journalFolder}" first.`);
      return;
    }
    const all = this.getEntries();
    const entry = all.find((e) => e.file.path === f.path);
    if (!entry) return;

    if (!force && (await this.entryHasReply(f))) {
      new Notice('This entry already has a reply. Use "Regenerate the reply" to rewrite it.');
      return;
    }

    const pending = new Notice("💌 Reading your entry…", 0);
    try {
      const ok = await this.replyTo(entry, all, force);
      pending.hide();
      new Notice(ok ? "💌 Your letter is at the end of the entry." : "The entry is a bit short — write a little more first.");
    } catch (e) {
      pending.hide();
      new Notice(`Reply failed: ${(e as Error).message}`, 10000);
    }
  }

  /** Replies to today's entry once it has gone untouched for N minutes. */
  async checkIdleToday() {
    const minutes = this.settings.idleReplyMinutes;
    if (!minutes || minutes <= 0 || !this.settings.apiKey) return;

    const today = mo().format("YYYY-MM-DD");
    const all = this.getEntries();
    const entry = all.find((e) => e.date.format("YYYY-MM-DD") === today);
    if (!entry) return;

    const last = this.lastEdit.get(entry.file.path);
    if (!last || Date.now() - last < minutes * 60 * 1000) return;
    this.lastEdit.delete(entry.file.path);

    try {
      if (await this.replyTo(entry, all)) new Notice("💌 Today's entry got a letter.");
    } catch (e) {
      console.error("[journal-companion]", e);
    }
  }

  // ---------------------------------------------------------------------------
  // Summaries
  // ---------------------------------------------------------------------------

  summaryPath(kind: SummaryKind, key: string): string {
    return normalizePath(`${this.settings.summaryFolder}/${kind}/${key}.md`);
  }

  summaryExists(kind: SummaryKind, key: string): boolean {
    return this.app.vault.getAbstractFileByPath(this.summaryPath(kind, key)) !== null;
  }

  async ensureFolder(path: string) {
    let current = "";
    for (const part of normalizePath(path).split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Created concurrently; safe to ignore.
        }
      }
    }
  }

  async writeSummary(path: string, content: string) {
    await this.ensureFolder(path.substring(0, path.lastIndexOf("/")));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  frontmatter(type: string, period: string, sources: number): string {
    return [
      "---",
      `type: ${type}`,
      `period: ${period}`,
      `sources: ${sources}`,
      `generated: ${mo().format("YYYY-MM-DD HH:mm")}`,
      `model: ${this.settings.summaryModel}`,
      "---",
      "",
      "",
    ].join("\n");
  }

  async entriesBlock(entries: Entry[]): Promise<string> {
    let s = "";
    for (const e of entries) {
      s += `--- ${e.date.format("YYYY-MM-DD ddd")} ---\n${truncate(await this.readEntry(e))}\n\n`;
    }
    return s;
  }

  /** Last period's questions, but only if the writer answered some of them. */
  async previousAnswers(kind: "Weekly" | "Monthly", key: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(this.summaryPath(kind, key));
    if (!(f instanceof TFile)) return "";
    const qa = extractQuestions(await this.app.vault.read(f));
    return hasAnswers(qa) ? qa : "";
  }

  async summarizeWeek(key: string, entries: Entry[]): Promise<string> {
    const start = entries[0].date.clone().startOf("isoWeek");
    const end = start.clone().endOf("isoWeek");
    const range = `${start.format("MMM D")} – ${end.format("MMM D")}`;

    const memory = await this.readMemory();
    const context = memory ? `[Long-term memory about the writer — background only]\n${truncate(memory, 4000)}\n\n` : "";
    const prevQA = await this.previousAnswers("Weekly", start.clone().subtract(1, "week").format(WEEK_KEY));
    const answers = prevQA ? `[Last week's questions and the writer's answers (✍️)]\n${prevQA}\n\n` : "";
    const user = `${context}${answers}${entries.length} entries from ${key} (${range}):\n\n${await this.entriesBlock(entries)}`;
    const body = addAnswerSlots(await this.ask(this.settings.summaryModel, WEEKLY_SUMMARY_PROMPT, user, 3000));
    const links = entries.map((e) => `- [[${e.file.basename}]]`).join("\n");

    await this.writeSummary(
      this.summaryPath("Weekly", key),
      this.frontmatter("weekly-summary", key, entries.length) +
        `# Week ${key} (${range})\n\n${body}\n\n${await this.moodBlock(entries)}---\n### Entries this week\n${links}\n`
    );
    return body;
  }

  async summarizeMonth(key: string, entries: Entry[]) {
    const month = mo(key, "YYYY-MM");
    const prevKey = month.clone().subtract(1, "month").format("YYYY-MM");
    const prevFile = this.app.vault.getAbstractFileByPath(this.summaryPath("Monthly", prevKey));

    let user = "";
    const memory = await this.readMemory();
    if (memory) user += `[Long-term memory about the writer — background only]\n${truncate(memory, 4000)}\n\n`;
    const prevQA = await this.previousAnswers("Monthly", prevKey);
    if (prevQA) user += `[Last month's questions and the writer's answers (✍️)]\n${prevQA}\n\n`;
    if (prevFile instanceof TFile) {
      user += `[Last month's summary — for comparison only]\n${truncate(await this.app.vault.cachedRead(prevFile), 3000)}\n\n`;
    }
    user += `[${entries.length} entries from ${month.format("MMMM YYYY")}]\n\n${await this.entriesBlock(entries)}`;

    const body = addAnswerSlots(await this.ask(this.settings.summaryModel, MONTHLY_SUMMARY_PROMPT, user, 4000));
    const calendar = this.settings.photoCalendar ? `### 📅\n\n![[${await this.refreshCalendar(key)}]]\n\n` : "";
    const weeks = [...new Set(entries.map((e) => e.date.format(WEEK_KEY)))];
    const links = weeks.map((w) => `- [[${w}]]`).join("\n");

    await this.writeSummary(
      this.summaryPath("Monthly", key),
      this.frontmatter("monthly-summary", key, entries.length) +
        `# ${month.format("MMMM YYYY")}\n\n${body}\n\n${await this.moodBlock(entries)}${calendar}---\n### Weekly summaries\n${links}\n`
    );
  }

  /** Builds the yearly review from monthly summaries, not raw entries. */
  async summarizeYear(year: string): Promise<boolean> {
    const months: { key: string; file: TFile }[] = [];
    for (let i = 1; i <= 12; i++) {
      const key = `${year}-${String(i).padStart(2, "0")}`;
      const f = this.app.vault.getAbstractFileByPath(this.summaryPath("Monthly", key));
      if (f instanceof TFile) months.push({ key, file: f });
    }
    if (!months.length) return false;

    let user = `[Monthly summaries for ${year}]\n\n`;
    for (const m of months) {
      user += `===== ${m.key} =====\n${truncate(await this.app.vault.cachedRead(m.file), 6000)}\n\n`;
    }

    const body = addAnswerSlots(await this.ask(this.settings.summaryModel, YEARLY_SUMMARY_PROMPT, user, 5500));
    const links = months.map((m) => `- [[${m.key}]]`).join("\n");

    await this.writeSummary(
      this.summaryPath("Yearly", year),
      this.frontmatter("yearly-summary", year, months.length) +
        `# ${year} in Review\n\n${body}\n\n---\n### Monthly summaries\n${links}\n`
    );
    return true;
  }

  async summarizeWeekOfActive() {
    const f = this.app.workspace.getActiveFile();
    const all = this.getEntries();
    const entry = f && all.find((e) => e.file.path === f.path);
    if (!entry) {
      new Notice("Open a journal entry first.");
      return;
    }

    const key = entry.date.format(WEEK_KEY);
    const entries = all.filter((e) => e.date.format(WEEK_KEY) === key);
    const pending = new Notice(`📖 Summarizing ${key}…`, 0);
    try {
      await this.summarizeWeek(key, entries);
      pending.hide();
      new Notice(`📖 Weekly summary for ${key} is ready.`);
      await this.app.workspace.openLinkText(this.summaryPath("Weekly", key), "", true);
    } catch (e) {
      pending.hide();
      new Notice(`Weekly summary failed: ${(e as Error).message}`, 10000);
    }
  }

  async summarizeMonthOfActive() {
    const f = this.app.workspace.getActiveFile();
    const all = this.getEntries();
    const entry = f && all.find((e) => e.file.path === f.path);
    if (!entry) {
      new Notice("Open a journal entry first.");
      return;
    }

    const key = entry.date.format("YYYY-MM");
    const entries = all.filter((e) => e.date.format("YYYY-MM") === key);
    const pending = new Notice(`📖 Summarizing ${key}…`, 0);
    try {
      await this.summarizeMonth(key, entries);
      pending.hide();
      new Notice(`📖 Monthly summary for ${key} is ready.`);
      await this.app.workspace.openLinkText(this.summaryPath("Monthly", key), "", true);
    } catch (e) {
      pending.hide();
      new Notice(`Monthly summary failed: ${(e as Error).message}`, 10000);
    }
  }

  // ---------------------------------------------------------------------------
  // Photos & calendar
  // ---------------------------------------------------------------------------

  /** Image files embedded in an entry, in order. */
  imagesIn(file: TFile): TFile[] {
    const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
    const images: TFile[] = [];
    for (const e of embeds) {
      const target = this.app.metadataCache.getFirstLinkpathDest(e.link.split("|")[0], file.path);
      if (target && isImagePath(target.path) && !images.includes(target)) images.push(target);
    }
    return images;
  }

  /** Groups runs of photos in an entry into a grid. Returns true if the entry changed. */
  async arrangeEntryPhotos(file: TFile): Promise<boolean> {
    // Check first, so untouched entries are never rewritten (or re-synced).
    const current = await this.app.vault.read(file);
    if (arrangePhotos(current) === current) return false;
    let changed = false;
    await this.app.vault.process(file, (text) => {
      const next = arrangePhotos(text);
      changed = next !== text;
      return next;
    });
    return changed;
  }

  /**
   * Downscales an image to a small JPEG for the vision model, which keeps
   * requests cheap. Returns null for formats the renderer can't decode (HEIC).
   */
  async imageForModel(file: TFile, maxSide = 768): Promise<ContentBlock | null> {
    try {
      const bitmap = await createImageBitmap(new Blob([await this.app.vault.readBinary(file)]));
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
      return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
    } catch {
      return null;
    }
  }

  /**
   * Picks the entry's cover photo and saves it as the `cover` property. One
   * photo is used as-is; with several, the small model looks at them alongside
   * the entry text and chooses. An existing cover is kept unless forced.
   */
  async chooseCover(entry: Entry, force = false): Promise<boolean> {
    if (!force && parseLink((await this.readFrontmatter(entry.file)).cover)) return false;
    const images = this.imagesIn(entry.file).slice(0, 8);
    if (!images.length) return false;

    let chosen = images[0];
    if (images.length > 1) {
      const content: ContentBlock[] = [];
      const candidates: TFile[] = [];
      for (const img of images) {
        const block = await this.imageForModel(img);
        if (!block) continue;
        candidates.push(img);
        content.push({ type: "text", text: `Photo ${candidates.length}:` }, block);
      }
      if (candidates.length > 1) {
        content.push({ type: "text", text: `Journal entry:\n${truncate(await this.readEntry(entry), 2500)}` });
        const idx = parseChoice(await this.ask(this.settings.dailyModel, COVER_PHOTO_PROMPT, content, 50), candidates.length);
        chosen = candidates[idx ?? 0];
      } else if (candidates.length === 1) {
        chosen = candidates[0];
      }
    }

    const link = this.app.metadataCache.fileToLinktext(chosen, entry.file.path, false);
    await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
      fm.cover = `[[${link}]]`;
    });
    return true;
  }

  calendarPath(key: string): string {
    return normalizePath(`${this.settings.summaryFolder}/Calendar/${key} Calendar.md`);
  }

  /** Rewrites the photo calendar for a month (YYYY-MM). Local only. Returns the note's link name. */
  async refreshCalendar(key: string): Promise<string> {
    const month = mo(key, "YYYY-MM");
    const entries = this.getEntries().filter((e) => e.date.format("YYYY-MM") === key);
    const days = new Map<number, CalendarDay>();
    for (const e of entries) {
      const fm = await this.readFrontmatter(e.file);
      const mood = toMood(fm);
      const coverLink = parseLink(fm.cover);
      const cover = coverLink ? this.app.metadataCache.getFirstLinkpathDest(coverLink, e.file.path) : null;
      days.set(e.date.date(), { link: e.file.basename, emoji: mood ? moodEmoji(mood.mood) : "", cover: cover?.path });
    }
    const sample = entries.length ? await this.readEntry(entries[entries.length - 1]) : "";
    const chinese = entries.length ? isMostlyCJK(sample) : true;
    const title = chinese ? `${month.format("YYYY年M月")} 日历` : `${month.format("MMMM YYYY")} Calendar`;
    const note =
      `---\ntype: photo-calendar\nperiod: ${key}\ncssclasses: [jc-calendar]\nupdated: ${mo().format("YYYY-MM-DD HH:mm")}\n---\n\n` +
      `# ${title}\n\n${calendarMarkdown(month.year(), month.month() + 1, days, chinese)}\n`;
    const path = this.calendarPath(key);
    await this.writeSummary(path, note);
    return `${key} Calendar`;
  }

  // ---------------------------------------------------------------------------
  // Mood & energy
  // ---------------------------------------------------------------------------

  /** Mood stored in an entry's frontmatter, read straight from the file so it's never stale. */
  /** An entry's frontmatter, read straight from the file so it's never stale. */
  async readFrontmatter(file: TFile): Promise<Record<string, unknown>> {
    const fm = (await this.app.vault.read(file)).match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return {};
    try {
      return (parseYaml(fm[1]) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  async readMood(file: TFile): Promise<Mood | null> {
    return toMood(await this.readFrontmatter(file));
  }

  /** Asks the small model for scores and saves them as properties on the entry. */
  async scoreEntry(entry: Entry, force = false): Promise<Mood | null> {
    if (!force && (await this.readMood(entry.file))) return null;
    const text = await this.readEntry(entry);
    if (text.length < 20) return null;

    // Decide the language in code: the model sometimes answers in English when a
    // Chinese entry starts with an English title.
    const chinese = isMostlyCJK(text);
    const system = MOOD_PROMPT + moodLanguageRule(chinese);
    let mood = parseMoodJson(await this.ask(this.settings.dailyModel, system, truncate(text), 200));
    if (mood && !feelingsInLanguage(mood.emotions, chinese)) {
      const retry = parseMoodJson(await this.ask(this.settings.dailyModel, system, truncate(text), 200));
      if (retry) mood = retry;
      // Still wrong: keep the scores, and only the words in the right language.
      mood = { ...mood, emotions: mood.emotions.filter((e) => feelingsInLanguage([e], chinese)) };
    }
    if (!mood) return null;

    await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
      fm.mood = mood.mood;
      fm.energy = mood.energy;
      fm.emotions = mood.emotions;
    });
    return mood;
  }

  async moodRows(entries: Entry[]): Promise<MoodRow[]> {
    const rows: MoodRow[] = [];
    for (const e of entries) {
      const m = await this.readMood(e.file);
      if (m) rows.push({ ...m, label: e.date.format("M/D"), day: e.date.format("ddd M/D") });
    }
    return rows;
  }

  /** Mood chart and table for a summary, in the journal's language. */
  async moodBlock(entries: Entry[]): Promise<string> {
    if (!this.settings.trackMood) return "";
    const rows = await this.moodRows(entries);
    if (!rows.length) return "";
    const sample = entries.length ? await this.readEntry(entries[entries.length - 1]) : "";
    const chinese = isMostlyCJK(sample);
    return `### ${chinese ? "心情与精力" : "Mood & energy"}\n\n${moodSection(rows, chinese)}\n\n`;
  }

  moodNotePath(): string {
    return normalizePath(`${this.settings.summaryFolder}/Mood.md`);
  }

  /** Rewrites Summaries/Mood.md for the last 30 days. Local only; no API calls. */
  async refreshMoodNote() {
    if (!this.settings.trackMood) return;
    const cutoff = mo().startOf("day").subtract(29, "days");
    const recent = this.getEntries().filter((e) => !e.date.isBefore(cutoff));
    const block = await this.moodBlock(recent);
    const note =
      `---\ntype: mood-chart\nupdated: ${mo().format("YYYY-MM-DD HH:mm")}\n---\n\n` +
      `# Mood & energy · last 30 days\n\n` +
      (block || "_No scored entries yet. Scores appear after an entry gets its letter._\n");
    await this.writeSummary(this.moodNotePath(), note);
  }

  // ---------------------------------------------------------------------------
  // Long-term memory
  // ---------------------------------------------------------------------------

  memoryFile(): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.memoryPath));
    return f instanceof TFile ? f : null;
  }

  /** Memory text for prompts (pinned notes + AI part), or "" if unused or missing. */
  async readMemory(): Promise<string> {
    if (!this.settings.useMemory) return "";
    const f = this.memoryFile();
    if (!f) return "";
    const { pinned, aiPart } = splitMemory(await this.app.vault.cachedRead(f));
    return [pinned && `Pinned by the writer:\n${pinned}`, aiPart].filter(Boolean).join("\n\n");
  }

  /**
   * Rewrites the AI-maintained part of the memory note from new material.
   * The writer's pinned section is carried over by code, never by the model.
   */
  async updateMemory(material: string) {
    const f = this.memoryFile();
    const { pinned, aiPart } = f ? splitMemory(await this.app.vault.read(f)) : { pinned: "", aiPart: "" };

    const user =
      `[Current memory]\n${aiPart || "(empty — this is the first time)"}\n\n` +
      `[Pinned by the writer — treat as true]\n${pinned || "(none)"}\n\n` +
      `[New material]\n${material}`;
    const updated = await this.ask(this.settings.summaryModel, MEMORY_UPDATE_PROMPT, user, 2000);
    if (!updated) return;

    const path = normalizePath(this.settings.memoryPath);
    await this.writeSummary(path, buildMemoryNote(pinned, updated, mo().format("YYYY-MM-DD HH:mm")));
  }

  /** First run: build the memory from every entry so far (most recent 60). */
  async bootstrapMemory(all: Entry[]) {
    const recent = all.slice(-60);
    let material = `${recent.length} journal entries, oldest first:\n\n`;
    for (const e of recent) {
      material += `--- ${e.date.format("YYYY-MM-DD ddd")} ---\n${truncate(await this.readEntry(e), 1500)}\n\n`;
    }
    await this.updateMemory(material);
  }

  async updateMemoryFromRecent() {
    const cutoff = mo().startOf("day").subtract(7, "days");
    const recent = this.getEntries().filter((e) => !e.date.isBefore(cutoff));
    if (!recent.length) {
      new Notice("No entries in the last 7 days.");
      return;
    }
    const pending = new Notice("🧠 Updating memory…", 0);
    try {
      await this.updateMemory(`Recent entries:\n\n${await this.entriesBlock(recent)}`);
      pending.hide();
      new Notice("🧠 Memory updated.");
      await this.app.workspace.openLinkText(normalizePath(this.settings.memoryPath), "", true);
    } catch (e) {
      pending.hide();
      new Notice(`Memory update failed: ${(e as Error).message}`, 10000);
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduler / catch-up
  // ---------------------------------------------------------------------------

  /**
   * Fills in anything that should exist but doesn't: replies to recent past
   * entries, then weekly → monthly → yearly summaries for completed periods.
   * The order matters: yearly reviews are built from monthly summaries.
   */
  async runChecks(manual: boolean) {
    if (this.busy) {
      if (manual) new Notice("Already working on it — hang on.");
      return;
    }
    if (!this.settings.apiKey) {
      if (manual) new Notice("Add your API key in the plugin settings first.");
      return;
    }

    this.busy = true;
    const done: string[] = [];
    try {
      const all = this.getEntries();
      const today = mo().startOf("day");

      // Build the memory once, before anything that uses it.
      if (this.settings.useMemory && all.length && !this.memoryFile()) {
        await this.bootstrapMemory(all);
        done.push("memory");
      }

      if (this.settings.autoReplyPastDays) {
        for (const e of all) {
          if (!e.date.isBefore(today)) continue;
          if (today.diff(e.date, "days") > this.settings.replyLookbackDays) continue;
          if (await this.replyTo(e, all)) done.push(`reply ${e.date.format("M/D")}`);
        }
      }

      // Photos on finished days: tidy grids (local), then a cover photo
      // (vision call only when a day has several photos). Covers come before
      // summaries, which embed the calendar.
      if (this.settings.arrangePhotos) {
        let arranged = 0;
        for (const e of all) if (e.date.isBefore(today) && (await this.arrangeEntryPhotos(e.file))) arranged++;
        if (arranged) done.push(`photos arranged ×${arranged}`);
      }
      if (this.settings.photoCalendar) {
        let covers = 0;
        for (const e of all) if (e.date.isBefore(today) && (await this.chooseCover(e))) covers++;
        if (covers) done.push(`covers ×${covers}`);
      }

      // Score finished days that don't have mood yet (includes older entries,
      // once). Must run before summaries, which chart these scores.
      if (this.settings.trackMood) {
        let scored = 0;
        for (const e of all) {
          if (!e.date.isBefore(today)) continue;
          if (await this.scoreEntry(e)) scored++;
        }
        if (scored) done.push(`mood ×${scored}`);
      }

      if (this.settings.autoSummaries) {
        for (const [key, entries] of groupBy(all, (e) => e.date.format(WEEK_KEY))) {
          const weekEnd = entries[0].date.clone().endOf("isoWeek");
          if (!weekEnd.isBefore(today) || this.summaryExists("Weekly", key)) continue;
          const summary = await this.summarizeWeek(key, entries);
          done.push(`week ${key}`);
          if (this.settings.useMemory) {
            await this.updateMemory(`Weekly summary for ${key}:\n${summary}\n\nEntries:\n\n${await this.entriesBlock(entries)}`);
          }
        }

        for (const [key, entries] of groupBy(all, (e) => e.date.format("YYYY-MM"))) {
          const monthEnd = mo(key, "YYYY-MM").endOf("month");
          if (!monthEnd.isBefore(today) || this.summaryExists("Monthly", key)) continue;
          await this.summarizeMonth(key, entries);
          done.push(`month ${key}`);
        }

        for (const year of new Set(all.map((e) => e.date.format("YYYY")))) {
          const yearEnd = mo(year, "YYYY").endOf("year");
          if (!yearEnd.isBefore(today) || this.summaryExists("Yearly", year)) continue;
          if (await this.summarizeYear(year)) done.push(`year ${year}`);
        }
      }

      await this.refreshMoodNote();
      if (this.settings.photoCalendar && all.length) {
        await this.refreshCalendar(today.format("YYYY-MM"));
        const lastMonth = today.clone().subtract(1, "month").format("YYYY-MM");
        if (all.some((e) => e.date.format("YYYY-MM") === lastMonth)) await this.refreshCalendar(lastMonth);
      }

      // Last, so every step above has finished with the files where they were.
      if (this.settings.organizeByMonth) {
        const moved = await this.organizeEntries();
        if (moved) done.push(`moved ${moved} into month folders`);
      }

      if (done.length) new Notice(`✨ Done: ${done.join(", ")}`, 8000);
      else if (manual) new Notice("Everything is up to date.");
    } catch (e) {
      console.error("[journal-companion]", e);
      new Notice(`Journal Companion error: ${(e as Error).message}`, 10000);
    } finally {
      this.busy = false;
    }
  }
}
