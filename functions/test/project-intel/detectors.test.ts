// Pure unit tests for the project-intelligence detectors. No network / no
// emulator — these exercise the deterministic heuristics directly.
import { describe, it, expect } from "vitest";
import { detectLanguage } from "../../src/pure";
import { classifyFile } from "../../src/project-intelligence/scanner/classify";
import { detectTechStack } from "../../src/project-intelligence/detectors/techStack";
import { detectFeatures } from "../../src/project-intelligence/detectors/features";
import { detectFirebaseFunctions, detectFirestoreCollections } from "../../src/project-intelligence/detectors/firebase";
import type { ScannedFile } from "../../src/project-intelligence/types";

function f(path: string, content?: string): ScannedFile {
  return {
    path,
    size: content ? content.length : 0,
    language: detectLanguage(path),
    role: classifyFile(path),
    content
  };
}

describe("detectTechStack", () => {
  it("maps package.json dependencies + config files to technologies", () => {
    const pkg = JSON.stringify({
      dependencies: { next: "15.0.0", express: "^4.21.0", "@prisma/client": "^5.0.0" },
      devDependencies: { vitest: "^2.0.0", typescript: "^5.7.0" }
    });
    const techs = detectTechStack([
      f("package.json", pkg),
      f("Dockerfile", "FROM node:22"),
      f("prisma/schema.prisma", "model User {}")
    ]);
    const byName = (n: string) => techs.find((t) => t.name === n);

    expect(byName("Next.js")?.category).toBe("frontend");
    expect(byName("Express")?.category).toBe("backend");
    expect(byName("Prisma")?.category).toBe("orm");
    expect(byName("Vitest")?.category).toBe("testing");
    expect(byName("Docker")?.category).toBe("deploy");
    expect(byName("Next.js")?.confidence).toBe("high");
  });

  it("does not invent technologies from an empty project", () => {
    const techs = detectTechStack([f("README.md", "# hi")]);
    expect(techs.find((t) => t.name === "Next.js")).toBeUndefined();
  });
});

describe("detectFeatures", () => {
  it("detects business features from folder/file heuristics", () => {
    const features = detectFeatures([
      f("app/auth/login.ts"),
      f("app/auth/session.ts"),
      f("app/auth/signup.ts"),
      f("src/billing/stripe.ts"),
      f("functions/src/routes/users.ts"),
      f("prisma/schema.prisma")
    ]);
    const keys = features.map((x) => x.key);
    expect(keys).toContain("auth");
    expect(keys).toContain("billing");
    expect(keys).toContain("api");
    expect(keys).toContain("database");

    const auth = features.find((x) => x.key === "auth")!;
    expect(auth.files.length).toBeGreaterThanOrEqual(3);
    expect(auth.confidence).toBe("high"); // dedicated dir + 3 files
  });

  it("returns nothing for unrelated files", () => {
    const features = detectFeatures([f("lib/math.ts"), f("lib/color.ts")]);
    expect(features.length).toBe(0);
  });
});

describe("detectFirebaseFunctions", () => {
  it("detects exported Cloud Functions and their trigger kind", () => {
    const fns = detectFirebaseFunctions([
      f("functions/src/index.ts", "export const api = onRequest({ memory: '2GiB' }, app);"),
      f("functions/src/tasks.ts", "export const ingestWorker = onTaskDispatched<IngestPayload>({}, async (req) => {});"),
      f("functions/src/projectScan.ts", "export const scanWorker = onTaskDispatched<ScanPayload>({}, async (r) => {});")
    ]);
    const byName = (n: string) => fns.find((x) => x.name === n);
    expect(byName("api")?.kind).toBe("https");
    expect(byName("ingestWorker")?.kind).toBe("task");
    expect(byName("scanWorker")?.kind).toBe("task");
  });

  it("returns nothing without function exports", () => {
    expect(detectFirebaseFunctions([f("src/util.ts", "export const x = 1;")])).toEqual([]);
  });
});

describe("detectFirestoreCollections", () => {
  it("attributes referencing files as readers or writers", () => {
    const cols = detectFirestoreCollections([
      f("functions/src/routes/projects.ts", "await db.collection('projects').doc(id).update({});"),
      f("functions/src/routes/list.ts", "const snap = await db.collection('projects').where('userId','==',u).get();")
    ]);
    const projects = cols.find((c) => c.name === "projects")!;
    expect(projects).toBeTruthy();
    expect(projects.writers).toContain("functions/src/routes/projects.ts");
    expect(projects.readers).toContain("functions/src/routes/list.ts");
  });

  it("ignores dynamic (variable) collection names", () => {
    const cols = detectFirestoreCollections([f("src/db.ts", "db.collection(name).get();")]);
    expect(cols.length).toBe(0);
  });
});
