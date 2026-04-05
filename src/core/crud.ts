import { readFile, writeFile, unlink, rename, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "glob";
import matter from "gray-matter";
import type { UpdateNoteOptions } from "./types.js";

export class NoteCrud {
  private notesPath: string;

  constructor(notesPath: string) {
    this.notesPath = notesPath;
  }

  async create(
    relativePath: string,
    content: string,
    frontmatter?: Record<string, unknown>
  ): Promise<string> {
    const absPath = join(this.notesPath, relativePath);
    if (existsSync(absPath)) {
      throw new Error(`Note already exists: ${relativePath}`);
    }

    await mkdir(dirname(absPath), { recursive: true });

    let fileContent: string;
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      fileContent = matter.stringify(content, frontmatter);
    } else {
      fileContent = content;
    }

    await writeFile(absPath, fileContent, "utf-8");
    return relativePath;
  }

  async read(relativePath: string): Promise<string> {
    const absPath = join(this.notesPath, relativePath);
    return readFile(absPath, "utf-8");
  }

  async readMultiple(paths: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    await Promise.all(
      paths.map(async (p) => {
        try {
          const content = await this.read(p);
          results.set(p, content);
        } catch {
          results.set(p, `[Error: could not read ${p}]`);
        }
      })
    );
    return results;
  }

  async update(
    relativePath: string,
    content: string,
    options: UpdateNoteOptions
  ): Promise<void> {
    const absPath = join(this.notesPath, relativePath);
    if (!existsSync(absPath)) {
      throw new Error(`Note does not exist: ${relativePath}`);
    }

    const existing = await readFile(absPath, "utf-8");

    let updated: string;

    switch (options.mode) {
      case "overwrite":
        updated = content;
        break;

      case "append":
        updated = existing + "\n" + content;
        break;

      case "prepend": {
        const { data, content: body } = matter(existing);
        const newBody = content + "\n" + body;
        updated = Object.keys(data).length > 0 ? matter.stringify(newBody, data) : newBody;
        break;
      }

      case "patch-by-heading": {
        if (!options.heading) throw new Error("patch-by-heading requires a heading");
        updated = this.patchByHeading(existing, options.heading, content);
        break;
      }
    }

    await writeFile(absPath, updated, "utf-8");
  }

  async delete(relativePath: string): Promise<void> {
    const absPath = join(this.notesPath, relativePath);
    if (!existsSync(absPath)) {
      throw new Error(`Note does not exist: ${relativePath}`);
    }
    await unlink(absPath);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const absFrom = join(this.notesPath, fromPath);
    const absTo = join(this.notesPath, toPath);

    if (!existsSync(absFrom)) {
      throw new Error(`Note does not exist: ${fromPath}`);
    }
    if (existsSync(absTo)) {
      throw new Error(`Destination already exists: ${toPath}`);
    }

    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);

    // Update wikilinks in other files that reference the old path
    await this.updateWikilinksAfterMove(fromPath, toPath);
  }

  private async updateWikilinksAfterMove(
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const oldName = oldPath.replace(/\.md$/, "").split("/").pop()!;
    const newName = newPath.replace(/\.md$/, "").split("/").pop()!;

    if (oldName === newName) return;

    const files = await glob("**/*.md", { cwd: this.notesPath });

    for (const file of files) {
      const absPath = join(this.notesPath, file);
      const content = await readFile(absPath, "utf-8");

      const pattern = new RegExp(`\\[\\[${escapeRegex(oldName)}(\\|[^\\]]*)?\\]\\]`, "g");
      if (!pattern.test(content)) continue;

      const updated = content.replace(pattern, `[[${newName}$1]]`);
      await writeFile(absPath, updated, "utf-8");
    }
  }

  private patchByHeading(
    content: string,
    heading: string,
    newContent: string
  ): string {
    const lines = content.split("\n");
    const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(heading)}\\s*$`, "i");

    let headingIndex = -1;
    let headingLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      if (headingPattern.test(lines[i])) {
        headingIndex = i;
        const match = lines[i].match(/^(#{1,6})\s+/);
        headingLevel = match ? match[1].length : 1;
        break;
      }
    }

    if (headingIndex === -1) {
      throw new Error(`Heading not found: ${heading}`);
    }

    // Find the end of this section (next heading of same or higher level)
    let endIndex = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+/);
      if (match && match[1].length <= headingLevel) {
        endIndex = i;
        break;
      }
    }

    const before = lines.slice(0, headingIndex + 1);
    const after = lines.slice(endIndex);

    return [...before, "", newContent, "", ...after].join("\n");
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
