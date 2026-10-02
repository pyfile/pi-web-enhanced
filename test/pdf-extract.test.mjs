import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const extractorUrl = new URL("../pdf-extract.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;

function errorSummary(stderr) {
	return stderr.split("\n").slice(0, 12).join("\n");
}

test("extractPDFToMarkdown works on Node 22 without native Promise.try", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF extraction failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);

	assert.match(child.stdout, /Hello PDF/);
	assert.match(child.stdout, /Second \(line\)/);
});

test("extractPDFToMarkdown stays local even when hosted keys are configured", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, { hostedKeys: true }),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF local-only assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Hello PDF/);
	assert.match(child.stdout, /"fetches":\[\]/);
});

test("extractPDFToMarkdown preserves caller cancellation", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, { abort: true }),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF cancellation assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Aborted/);
});

test("extractPDFToMarkdown passes PDF.js errors-only verbosity", () => {
	const loaderDir = mkdtempSync(join(tmpdir(), "pi-web-enhanced-pdf-loader-"));
	const loaderPath = join(loaderDir, "unpdf-loader.mjs");
	writeFileSync(loaderPath, buildUnpdfLoader());

	try {
		const child = spawnSync(
			process.execPath,
			["--experimental-loader", loaderPath, "--input-type=module"],
			{
				input: buildChildScript(extractorUrl, { printOptions: true }),
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
			},
		);

		assert.equal(
			child.status,
			0,
			"PDF verbosity assertion failed in a child process. stderr summary:\n" +
				errorSummary(child.stderr),
		);

		const options = JSON.parse(child.stdout.trim().split("\n").at(-1));
		assert.equal(options.verbosity, 0);
	} finally {
		rmSync(loaderDir, { recursive: true, force: true });
	}
});

function buildUnpdfLoader() {
	const unpdfUrl = pathToFileURL(require.resolve("unpdf")).href;
	return `
    const unpdfUrl = ${JSON.stringify(unpdfUrl)};

    export function resolve(specifier, context, nextResolve) {
      if (specifier === "unpdf") {
        return { url: "pi-web-enhanced:test-unpdf", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }

    export async function load(url, context, nextLoad) {
      if (url === "pi-web-enhanced:test-unpdf") {
        return {
          format: "module",
          shortCircuit: true,
          source:
            "import * as unpdf from " + JSON.stringify(unpdfUrl) + ";" +
            "export const getDocumentProxy = (...args) => {" +
            "  globalThis.__piWebAccessUnpdfOptions = args[1];" +
            "  return unpdf.getDocumentProxy(...args);" +
            "};",
        };
      }
      return nextLoad(url, context);
    }
  `;
}

function buildChildScript(moduleUrl, { printOptions = false, abort = false, hostedKeys = false } = {}) {
	return `
        import { mkdtemp, readFile, writeFile } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { makePdf } from ${JSON.stringify(fixtureUrl)};

        process.on("uncaughtException", (error) => {
          console.error(error?.stack || error);
          process.exit(1);
        });
        process.on("unhandledRejection", (error) => {
          console.error(error?.stack || error);
          process.exit(1);
        });

        Reflect.deleteProperty(Promise, "try");
        if (typeof Promise.try !== "undefined") {
          throw new Error("Expected Promise.try to be unavailable before PDF extraction");
        }

        const abort = ${JSON.stringify(abort)};
        const hostedKeys = ${JSON.stringify(hostedKeys)};
        const configDir = await mkdtemp(join(tmpdir(), "pi-web-enhanced-pdf-config-"));
        process.env.PI_CODING_AGENT_DIR = configDir;

        if (hostedKeys) {
          process.env.GEMINI_API_KEY = "synthetic-gemini-key";
          process.env.DATALAB_API_KEY = "synthetic-datalab-key";
        } else {
          delete process.env.GEMINI_API_KEY;
          delete process.env.DATALAB_API_KEY;
          delete process.env.GOOGLE_GEMINI_BASE_URL;
          delete process.env.CLOUDFLARE_API_KEY;
        }

        const fetches = [];
        globalThis.fetch = async (url) => {
          fetches.push(String(url));
          throw new Error("PDF extraction must not fetch: " + String(url));
        };

        const { extractPDFToMarkdown } = await import(${JSON.stringify(moduleUrl)});
        const outputDir = await mkdtemp(join(tmpdir(), "pi-web-enhanced-pdf-"));

        if (abort) {
          const controller = new AbortController();
          controller.abort();
          let preservedCancellation = false;
          try {
            await extractPDFToMarkdown(
              makePdf("Hello PDF"),
              "https://example.test/hello.pdf",
              { outputDir, signal: controller.signal },
            );
          } catch (error) {
            preservedCancellation = /abort/i.test(error instanceof Error ? error.message : String(error));
            if (!preservedCancellation) throw error;
          }
          if (!preservedCancellation) throw new Error("Expected PDF extraction to preserve cancellation");
          console.log("Aborted");
        } else {
          const result = await extractPDFToMarkdown(
            makePdf("Hello PDF\\nSecond (line)"),
            "https://example.test/hello.pdf",
            { outputDir },
          );

          const saved = await readFile(result.outputPath, "utf8");
          if (result.content !== saved || result.chars !== saved.length) {
            throw new Error("Returned PDF Markdown must match the saved file and character count");
          }
          console.log(saved);
          console.log(JSON.stringify({ fetches }));
          ${printOptions ? "console.log(JSON.stringify(globalThis.__piWebAccessUnpdfOptions));" : ""}
        }

  `;
}
