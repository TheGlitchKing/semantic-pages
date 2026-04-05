import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FrontmatterManager, TagManager } from "../../src/core/frontmatter.js";
import { createTempVault, cleanupTempDir } from "../setup.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("FrontmatterManager", () => {
  let tempDir: string;
  let fm: FrontmatterManager;

  beforeEach(async () => {
    tempDir = await createTempVault();
    fm = new FrontmatterManager(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should get frontmatter", async () => {
    const data = await fm.get("project-overview.md");
    expect(data.title).toBe("Project Overview");
    expect(data.tags).toEqual(["project", "overview"]);
  });

  it("should return empty object for no frontmatter", async () => {
    const data = await fm.get("no-frontmatter.md");
    expect(data).toEqual({});
  });

  it("should set frontmatter fields", async () => {
    await fm.update("project-overview.md", { status: "active", priority: 1 });
    const data = await fm.get("project-overview.md");
    expect(data.status).toBe("active");
    expect(data.priority).toBe(1);
    expect(data.title).toBe("Project Overview"); // existing fields preserved
  });

  it("should delete frontmatter fields with null", async () => {
    await fm.update("project-overview.md", { title: null });
    const data = await fm.get("project-overview.md");
    expect(data.title).toBeUndefined();
  });

  it("should not corrupt note content", async () => {
    await fm.update("project-overview.md", { newField: "test" });
    const raw = await readFile(join(tempDir, "project-overview.md"), "utf-8");
    expect(raw).toContain("Architecture");
    expect(raw).toContain("[[microservices]]");
  });
});

describe("TagManager", () => {
  let tempDir: string;
  let tags: TagManager;

  beforeEach(async () => {
    tempDir = await createTempVault();
    tags = new TagManager(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should list all tags (frontmatter + inline)", async () => {
    const result = await tags.list("project-overview.md");
    expect(result).toContain("project");
    expect(result).toContain("overview");
    expect(result).toContain("architecture");
    expect(result).toContain("goals");
  });

  it("should add tags to frontmatter", async () => {
    await tags.add("project-overview.md", ["new-tag", "another"]);
    const result = await tags.list("project-overview.md");
    expect(result).toContain("new-tag");
    expect(result).toContain("another");
    expect(result).toContain("project"); // existing preserved
  });

  it("should not duplicate existing tags", async () => {
    await tags.add("project-overview.md", ["project"]);
    const raw = await readFile(join(tempDir, "project-overview.md"), "utf-8");
    const matches = raw.match(/- project/g);
    expect(matches?.length).toBe(1);
  });

  it("should remove tags from frontmatter", async () => {
    await tags.remove("project-overview.md", ["project"]);
    const fm = await readFile(join(tempDir, "project-overview.md"), "utf-8");
    // "project" should be gone from frontmatter tags
    expect(fm).not.toMatch(/^\s+- project$/m);
  });

  it("should rename tags vault-wide", async () => {
    const count = await tags.renameVaultWide("architecture", "arch");
    expect(count).toBeGreaterThan(0);

    // Check that old tag is gone and new tag exists
    const overview = await readFile(join(tempDir, "project-overview.md"), "utf-8");
    expect(overview).toContain("#arch");
    expect(overview).not.toContain("#architecture");
  });
});
