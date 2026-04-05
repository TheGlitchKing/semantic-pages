import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import matter from "gray-matter";

export class FrontmatterManager {
  private notesPath: string;

  constructor(notesPath: string) {
    this.notesPath = notesPath;
  }

  async get(relativePath: string): Promise<Record<string, unknown>> {
    const absPath = join(this.notesPath, relativePath);
    const raw = await readFile(absPath, "utf-8");
    const { data } = matter(raw);
    return data;
  }

  async update(
    relativePath: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    const absPath = join(this.notesPath, relativePath);
    const raw = await readFile(absPath, "utf-8");
    const { data, content } = matter(raw);

    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) {
        delete data[key];
      } else {
        data[key] = value;
      }
    }

    const updated = matter.stringify(content, data);
    await writeFile(absPath, updated, "utf-8");
  }
}

export class TagManager {
  private notesPath: string;

  constructor(notesPath: string) {
    this.notesPath = notesPath;
  }

  async list(relativePath: string): Promise<string[]> {
    const absPath = join(this.notesPath, relativePath);
    const raw = await readFile(absPath, "utf-8");
    const { data, content } = matter(raw);

    const fmTags = Array.isArray(data.tags) ? (data.tags as string[]) : [];
    const inlineTags = [...content.matchAll(/(?:^|\s)#([a-zA-Z][\w-/]*)/g)].map(
      (m) => m[1]
    );

    return [...new Set([...fmTags, ...inlineTags])];
  }

  async add(relativePath: string, tags: string[]): Promise<void> {
    const absPath = join(this.notesPath, relativePath);
    const raw = await readFile(absPath, "utf-8");
    const { data, content } = matter(raw);

    const existing = Array.isArray(data.tags) ? (data.tags as string[]) : [];
    const merged = [...new Set([...existing, ...tags])];
    data.tags = merged;

    const updated = matter.stringify(content, data);
    await writeFile(absPath, updated, "utf-8");
  }

  async remove(relativePath: string, tags: string[]): Promise<void> {
    const absPath = join(this.notesPath, relativePath);
    const raw = await readFile(absPath, "utf-8");
    const { data, content } = matter(raw);

    // Remove from frontmatter
    if (Array.isArray(data.tags)) {
      data.tags = (data.tags as string[]).filter((t) => !tags.includes(t));
    }

    // Remove inline tags
    let updatedContent = content;
    for (const tag of tags) {
      const pattern = new RegExp(`(^|\\s)#${escapeRegex(tag)}(?=\\s|$)`, "g");
      updatedContent = updatedContent.replace(pattern, "$1");
    }

    const updated = matter.stringify(updatedContent, data);
    await writeFile(absPath, updated, "utf-8");
  }

  async renameVaultWide(oldTag: string, newTag: string): Promise<number> {
    const files = await glob("**/*.md", { cwd: this.notesPath });
    let count = 0;

    for (const file of files) {
      const absPath = join(this.notesPath, file);
      const raw = await readFile(absPath, "utf-8");
      const { data, content } = matter(raw);
      let changed = false;

      // Rename in frontmatter
      if (Array.isArray(data.tags)) {
        const idx = (data.tags as string[]).indexOf(oldTag);
        if (idx >= 0) {
          (data.tags as string[])[idx] = newTag;
          changed = true;
        }
      }

      // Rename inline tags
      const pattern = new RegExp(`(^|\\s)#${escapeRegex(oldTag)}(?=\\s|$)`, "g");
      const updatedContent = content.replace(pattern, `$1#${newTag}`);
      if (updatedContent !== content) changed = true;

      if (changed) {
        const updated = matter.stringify(updatedContent, data);
        await writeFile(absPath, updated, "utf-8");
        count++;
      }
    }

    return count;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
