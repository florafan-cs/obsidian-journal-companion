import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type JournalCompanion from "./main";

export interface JournalCompanionSettings {
  apiKey: string;
  journalFolder: string;
  summaryFolder: string;
  dailyModel: string;
  summaryModel: string;
  autoReplyPastDays: boolean;
  replyLookbackDays: number;
  /** Minutes of no edits before today's entry gets a reply. 0 disables it. */
  idleReplyMinutes: number;
  /** How many previous entries to include as background for a reply. */
  contextDays: number;
  autoSummaries: boolean;
  extraStyle: string;
  /** Name used in the stats line, e.g. "Flora". Empty = "you". */
  yourName: string;
  showStats: boolean;
  /** Active writing time per entry date (YYYY-MM-DD → milliseconds). */
  writingTime: Record<string, number>;
  useMemory: boolean;
  memoryPath: string;
}

export const DEFAULT_SETTINGS: JournalCompanionSettings = {
  apiKey: "",
  journalFolder: "Journal",
  summaryFolder: "Journal/Summaries",
  dailyModel: "claude-haiku-4-5-20251001",
  summaryModel: "claude-sonnet-5",
  autoReplyPastDays: true,
  replyLookbackDays: 7,
  idleReplyMinutes: 0,
  contextDays: 2,
  autoSummaries: true,
  extraStyle: "",
  yourName: "",
  showStats: true,
  writingTime: {},
  useMemory: true,
  memoryPath: "Journal/Summaries/Memory.md",
};

export class CompanionSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JournalCompanion) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const intSetting = (
      name: string,
      desc: string,
      get: () => number,
      set: (n: number) => void,
      min: number
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(get())).onChange(async (v) => {
            const n = parseInt(v, 10);
            set(Number.isFinite(n) ? Math.max(min, n) : min);
            await save();
          })
        );

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Create one at console.anthropic.com → API Keys (starts with sk-ant-). " +
          "Stored in this vault's plugin data file."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(s.apiKey)
          .onChange(async (v) => {
            s.apiKey = v.trim();
            await save();
          });
      })
      .addButton((b) =>
        b.setButtonText("Test connection").onClick(async () => {
          try {
            const r = await this.plugin.ask(s.dailyModel, "Reply with just: OK", "ping", 10);
            new Notice(`✅ Connected: ${r}`);
          } catch (e) {
            new Notice(`❌ ${(e as Error).message}`, 10000);
          }
        })
      );

    new Setting(containerEl)
      .setName("Journal folder")
      .setDesc("Entry filenames must start with YYYY-MM-DD.")
      .addText((t) =>
        t.setValue(s.journalFolder).onChange(async (v) => {
          s.journalFolder = v.trim();
          await save();
        })
      );

    new Setting(containerEl).setName("Summary folder").addText((t) =>
      t.setValue(s.summaryFolder).onChange(async (v) => {
        s.summaryFolder = v.trim();
        await save();
      })
    );

    new Setting(containerEl).setName("Daily replies").setHeading();

    new Setting(containerEl)
      .setName("Auto-reply to past entries")
      .setDesc(
        "When Obsidian opens (and every 30 minutes after), reply to entries from before today that don't have a reply yet."
      )
      .addToggle((t) =>
        t.setValue(s.autoReplyPastDays).onChange(async (v) => {
          s.autoReplyPastDays = v;
          await save();
        })
      );

    intSetting(
      "Look-back window (days)",
      "Only auto-reply to entries this recent, so old entries aren't back-filled.",
      () => s.replyLookbackDays,
      (n) => (s.replyLookbackDays = n),
      1
    );

    intSetting(
      "Reply to today's entry after N idle minutes",
      "0 = off. Otherwise click the ❤️ ribbon icon when you're done, or wait for tomorrow's auto-reply.",
      () => s.idleReplyMinutes,
      (n) => (s.idleReplyMinutes = n),
      0
    );

    intSetting(
      "Previous entries as context",
      "Include the previous N entries as background so replies feel continuous.",
      () => s.contextDays,
      (n) => (s.contextDays = n),
      0
    );

    new Setting(containerEl)
      .setName("Extra style instructions")
      .setDesc('Optional, e.g. "a bit more humor" or "my cat is called Mochi".')
      .addTextArea((t) =>
        t.setValue(s.extraStyle).onChange(async (v) => {
          s.extraStyle = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Show writing stats")
      .setDesc(
        "Start each letter with days journaled, total words, and today's word count, writing time and speed. " +
          "Time is measured while you type; pauses over 2 minutes don't count."
      )
      .addToggle((t) =>
        t.setValue(s.showStats).onChange(async (v) => {
          s.showStats = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Your name")
      .setDesc('Used in the stats line, e.g. "Flora has journaled for 30 days". Leave empty for "you".')
      .addText((t) =>
        t.setValue(s.yourName).onChange(async (v) => {
          s.yourName = v.trim();
          await save();
        })
      );

    new Setting(containerEl).setName("Reply model").addText((t) =>
      t.setValue(s.dailyModel).onChange(async (v) => {
        s.dailyModel = v.trim();
        await save();
      })
    );

    new Setting(containerEl).setName("Long-term memory").setHeading();

    new Setting(containerEl)
      .setName("Use long-term memory")
      .setDesc(
        "Keep a note of the people, goals and worries in your journal, update it after each week, and use it in letters and summaries."
      )
      .addToggle((t) =>
        t.setValue(s.useMemory).onChange(async (v) => {
          s.useMemory = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Memory note")
      .setDesc("You can open and edit this note any time.")
      .addText((t) =>
        t.setValue(s.memoryPath).onChange(async (v) => {
          s.memoryPath = v.trim();
          await save();
        })
      );

    new Setting(containerEl).setName("Weekly / monthly / yearly summaries").setHeading();

    new Setting(containerEl)
      .setName("Generate summaries automatically")
      .setDesc(
        "Created after each week (Mon–Sun), month, and year ends. Periods missed while your computer was off are filled in next time Obsidian opens."
      )
      .addToggle((t) =>
        t.setValue(s.autoSummaries).onChange(async (v) => {
          s.autoSummaries = v;
          await save();
        })
      );

    new Setting(containerEl).setName("Summary model").addText((t) =>
      t.setValue(s.summaryModel).onChange(async (v) => {
        s.summaryModel = v.trim();
        await save();
      })
    );
  }
}
