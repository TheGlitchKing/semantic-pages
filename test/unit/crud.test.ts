import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NoteCrud } from "../../src/core/crud.js";
import { createTempVault, cleanupTempDir } from "../setup.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import matter from "gray-matter";

describe("NoteCrud", () => {
  let tempDir: string;
  let crud: NoteCrud;

  beforeEach(async () => {
    tempDir = await createTempVault();
    crud = new NoteCrud(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("create", () => {
    it("should create a new note", async () => {
      await crud.create("new-note.md", "# New Note\n\nHello world.");
      const content = await readFile(join(tempDir, "new-note.md"), "utf-8");
      expect(content).toContain("Hello world");
    });

    it("should create with frontmatter", async () => {
      await crud.create("tagged.md", "Content here.", { title: "Tagged", tags: ["test"] });
      const content = await readFile(join(tempDir, "tagged.md"), "utf-8");
      expect(content).toContain("title: Tagged");
      expect(content).toContain("test");
    });

    it("should create in nested directories", async () => {
      await crud.create("deep/nested/note.md", "Nested content.");
      expect(existsSync(join(tempDir, "deep/nested/note.md"))).toBe(true);
    });

    it("should throw if note already exists", async () => {
      await expect(crud.create("project-overview.md", "Overwrite attempt")).rejects.toThrow(
        "already exists"
      );
    });
  });

  describe("read", () => {
    it("should read an existing note", async () => {
      const content = await crud.read("project-overview.md");
      expect(content).toContain("Project Overview");
    });

    it("should throw for nonexistent note", async () => {
      await expect(crud.read("does-not-exist.md")).rejects.toThrow();
    });
  });

  describe("readMultiple", () => {
    it("should read multiple notes", async () => {
      const results = await crud.readMultiple(["project-overview.md", "microservices.md"]);
      expect(results.size).toBe(2);
      expect(results.get("project-overview.md")).toContain("Project Overview");
      expect(results.get("microservices.md")).toContain("Microservices");
    });

    it("should handle missing files gracefully", async () => {
      const results = await crud.readMultiple(["project-overview.md", "nope.md"]);
      expect(results.get("nope.md")).toContain("[Error:");
    });
  });

  describe("update", () => {
    it("should overwrite content (auto-stamps frontmatter)", async () => {
      // NoteCrud.update auto-stamps last_updated, word_count, and
      // estimated_read_time on every update regardless of mode. See
      // src/core/crud.ts:93-98 (computeStamps applied after the mode switch).
      // This test asserts both that the body is replaced AND that the
      // auto-stamps land in the resulting frontmatter.
      await crud.update("orphan.md", "Completely new content.", { mode: "overwrite" });
      const content = await readFile(join(tempDir, "orphan.md"), "utf-8");
      const parsed = matter(content);
      expect(parsed.content.trim()).toBe("Completely new content.");
      expect(parsed.data).toHaveProperty("last_updated");
      expect(parsed.data).toHaveProperty("word_count", 3);
      expect(parsed.data).toHaveProperty("estimated_read_time");
    });

    it("should append content", async () => {
      await crud.update("orphan.md", "\n## Appendix\n\nAppended.", { mode: "append" });
      const content = await readFile(join(tempDir, "orphan.md"), "utf-8");
      expect(content).toContain("Orphan Note");
      expect(content).toContain("Appendix");
    });

    it("should prepend content after frontmatter", async () => {
      await crud.update("orphan.md", "Prepended line.", { mode: "prepend" });
      const content = await readFile(join(tempDir, "orphan.md"), "utf-8");
      expect(content).toContain("Prepended line.");
      // Frontmatter should still be at the top
      expect(content.indexOf("---")).toBe(0);
    });

    it("should patch by heading", async () => {
      await crud.update("project-overview.md", "New architecture content.", {
        mode: "patch-by-heading",
        heading: "Architecture",
      });
      const content = await readFile(join(tempDir, "project-overview.md"), "utf-8");
      expect(content).toContain("New architecture content.");
      expect(content).toContain("## Goals"); // Other sections preserved
    });

    it("should throw for nonexistent note", async () => {
      await expect(
        crud.update("nope.md", "content", { mode: "overwrite" })
      ).rejects.toThrow("does not exist");
    });

    it("should throw for missing heading in patch mode", async () => {
      await expect(
        crud.update("project-overview.md", "content", {
          mode: "patch-by-heading",
          heading: "Nonexistent Section",
        })
      ).rejects.toThrow("Heading not found");
    });
  });

  describe("delete", () => {
    it("should delete a note", async () => {
      await crud.delete("orphan.md");
      expect(existsSync(join(tempDir, "orphan.md"))).toBe(false);
    });

    it("should throw for nonexistent note", async () => {
      await expect(crud.delete("nope.md")).rejects.toThrow("does not exist");
    });
  });

  describe("move", () => {
    it("should move a note", async () => {
      await crud.move("orphan.md", "moved/orphan-moved.md");
      expect(existsSync(join(tempDir, "orphan.md"))).toBe(false);
      expect(existsSync(join(tempDir, "moved/orphan-moved.md"))).toBe(true);
    });

    it("should update wikilinks when renaming", async () => {
      // microservices.md links to user-service
      await crud.move("user-service.md", "auth-service.md");
      const micro = await readFile(join(tempDir, "microservices.md"), "utf-8");
      expect(micro).toContain("[[auth-service]]");
      expect(micro).not.toContain("[[user-service]]");
    });

    it("should throw if source doesn't exist", async () => {
      await expect(crud.move("nope.md", "dest.md")).rejects.toThrow("does not exist");
    });

    it("should throw if destination exists", async () => {
      await expect(
        crud.move("orphan.md", "project-overview.md")
      ).rejects.toThrow("already exists");
    });
  });
});
