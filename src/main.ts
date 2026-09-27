import { Notice, Plugin, TFile, TFolder, moment, normalizePath } from "obsidian";
import { callClaude } from "./claude";
import {
  DAILY_REPLY_PROMPT,
  MONTHLY_SUMMARY_PROMPT,
  WEEKLY_SUMMARY_PROMPT,
  YEARLY_SUMMARY_PROMPT,
} from "./prompts";
import { CompanionSettingTab, DEFAULT_SETTINGS, JournalCompanionSettings } from "./settings";
import { extractDate, hasReply, stripReplies, toCallout, truncate } from "./utils";

// Obsidian re-exports moment, but its typings aren't callable under TS 5.x.
const mo = moment as unknown as (...args: unknown[]) => moment.Moment;

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;
const WEEK_KEY = "GGGG-[W]WW"; // ISO week, e.g. 2026-W39

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
      id: "catch-up",
      name: "Catch up now: missing replies and summaries",
      callback: () => this.runChecks(true),
    });

    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && this.isJournal(f)) this.lastEdit.set(f.path, Date.now());
      })
    );

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.runChecks(false), 5000);
    });
    this.registerInterval(window.setInterval(() => this.runChecks(false), CHECK_INTERVAL_MS));
    this.registerInterval(window.setInterval(() => this.checkIdleToday(), IDLE_POLL_MS));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Thin wrapper so the settings tab can test the connection. */
  ask(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    return callClaude({ apiKey: this.settings.apiKey, model, system, user, maxTokens });
  }

  // ---------------------------------------------------------------------------
  // Journal discovery
  // ---------------------------------------------------------------------------

  isJournal(f: TFile): boolean {
    return (
      f.extension === "md" &&
      f.parent?.path === normalizePath(this.settings.journalFolder) &&
      extractDate(f.basename) !== null
    );
  }

  /** All journal entries in the configured folder, oldest first. */
  getEntries(): Entry[] {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.journalFolder));
    if (!(folder instanceof TFolder)) return [];

    const entries: Entry[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || !this.isJournal(child)) continue;
      const date = mo(extractDate(child.basename), "YYYY-MM-DD", true);
      if (date.isValid()) entries.push({ file: child, date });
    }
    return entries.sort((a, b) => a.date.valueOf() - b.date.valueOf());
  }

  /** Entry text with any previous AI replies removed. */
  async readEntry(e: Entry): Promise<string> {
    return stripReplies(await this.app.vault.cachedRead(e.file));
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

      // vault.process is atomic, so a concurrent edit can't be overwritten.
      await this.app.vault.process(f, (content) => {
        const base = force ? stripReplies(content) : content.trimEnd();
        return base + toCallout(reply, mo().format("YYYY-MM-DD HH:mm"));
      });
      return true;
    } finally {
      this.replying.delete(f.path);
    }
  }

  async replyToActive(force: boolean) {
    const f = this.app.workspace.getActiveFile();
    if (!f || !this.isJournal(f)) {
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

  async summarizeWeek(key: string, entries: Entry[]) {
    const start = entries[0].date.clone().startOf("isoWeek");
    const end = start.clone().endOf("isoWeek");
    const range = `${start.format("MMM D")} – ${end.format("MMM D")}`;

    const user = `${entries.length} entries from ${key} (${range}):\n\n${await this.entriesBlock(entries)}`;
    const body = await this.ask(this.settings.summaryModel, WEEKLY_SUMMARY_PROMPT, user, 2500);
    const links = entries.map((e) => `- [[${e.file.basename}]]`).join("\n");

    await this.writeSummary(
      this.summaryPath("Weekly", key),
      this.frontmatter("weekly-summary", key, entries.length) +
        `# Week ${key} (${range})\n\n${body}\n\n---\n### Entries this week\n${links}\n`
    );
  }

  async summarizeMonth(key: string, entries: Entry[]) {
    const month = mo(key, "YYYY-MM");
    const prevKey = month.clone().subtract(1, "month").format("YYYY-MM");
    const prevFile = this.app.vault.getAbstractFileByPath(this.summaryPath("Monthly", prevKey));

    let user = "";
    if (prevFile instanceof TFile) {
      user += `[Last month's summary — for comparison only]\n${truncate(await this.app.vault.cachedRead(prevFile), 3000)}\n\n`;
    }
    user += `[${entries.length} entries from ${month.format("MMMM YYYY")}]\n\n${await this.entriesBlock(entries)}`;

    const body = await this.ask(this.settings.summaryModel, MONTHLY_SUMMARY_PROMPT, user, 3500);
    const weeks = [...new Set(entries.map((e) => e.date.format(WEEK_KEY)))];
    const links = weeks.map((w) => `- [[${w}]]`).join("\n");

    await this.writeSummary(
      this.summaryPath("Monthly", key),
      this.frontmatter("monthly-summary", key, entries.length) +
        `# ${month.format("MMMM YYYY")}\n\n${body}\n\n---\n### Weekly summaries\n${links}\n`
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

    const body = await this.ask(this.settings.summaryModel, YEARLY_SUMMARY_PROMPT, user, 5000);
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

      if (this.settings.autoReplyPastDays) {
        for (const e of all) {
          if (!e.date.isBefore(today)) continue;
          if (today.diff(e.date, "days") > this.settings.replyLookbackDays) continue;
          if (await this.replyTo(e, all)) done.push(`reply ${e.date.format("M/D")}`);
        }
      }

      if (this.settings.autoSummaries) {
        for (const [key, entries] of groupBy(all, (e) => e.date.format(WEEK_KEY))) {
          const weekEnd = entries[0].date.clone().endOf("isoWeek");
          if (!weekEnd.isBefore(today) || this.summaryExists("Weekly", key)) continue;
          await this.summarizeWeek(key, entries);
          done.push(`week ${key}`);
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
