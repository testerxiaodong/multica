import { expect, test } from "@playwright/test";
import { buildSurfaceFrameDocument } from "../packages/views/plugins/surface-document";

/**
 * Real Chromium coverage for the trusted wrapper around hosted plugin content:
 * reloading the wrapper and relaying an immediate guest error to the host.
 */

test.describe("plugin surface document (real Chromium, hosted sandboxed content)", () => {
  test("a host-authored srcdoc reload is not reported as hostile navigation", async ({ page }) => {
    await page.route("https://plugin-content.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          parent.parent.postMessage({ type: "plugin-test-ran" }, "*");
        </script>`,
      });
    });
    const first = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/first",
      bridgeToken: "first-proof",
    });
    const replacement = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/replacement",
      bridgeToken: "replacement-proof",
    });

    await page.setContent("<!doctype html><body></body>");
    await page.evaluate((srcdoc) => {
      const state = { ran: 0, navigated: 0 };
      (window as unknown as { __surfaceState: typeof state }).__surfaceState = state;
      window.addEventListener("message", (event) => {
        const type = (event.data as { type?: string } | null)?.type;
        if (type === "plugin-test-ran") state.ran++;
        if (type === "multica:plugin-surface-navigated") state.navigated++;
      });
      const frame = document.createElement("iframe");
      frame.id = "surface";
      frame.sandbox.add("allow-scripts", "allow-same-origin");
      frame.srcdoc = srcdoc;
      document.body.appendChild(frame);
    }, first);

    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __surfaceState: { ran: number } }).__surfaceState.ran,
    )).toBe(1);

    await page.evaluate((srcdoc) => {
      document.querySelector<HTMLIFrameElement>("#surface")!.srcdoc = srcdoc;
    }, replacement);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __surfaceState: { ran: number } }).__surfaceState.ran,
    )).toBe(2);

    expect(await page.evaluate(() =>
      (window as unknown as { __surfaceState: { navigated: number } }).__surfaceState.navigated,
    )).toBe(0);
  });

  test("relays a synchronous guest error to the host listener armed before launch", async ({ page }) => {
    await page.route("https://plugin-content.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          window.addEventListener("error", () => {
            parent.postMessage({ type: "multica:plugin-surface-error" }, "*");
          });
          throw new Error("plugin failed during bootstrap");
        </script>`,
      });
    });
    const documentWithError = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/error",
      bridgeToken: "error-proof",
    });

    await page.setContent("<!doctype html><body></body>");
    await page.evaluate((srcdoc) => {
      (window as unknown as { __surfaceErrors: number }).__surfaceErrors = 0;
      const frame = document.createElement("iframe");
      frame.id = "surface";
      frame.sandbox.add("allow-scripts", "allow-same-origin");
      document.body.appendChild(frame);
      // Production arms the host listener before assigning srcdoc: the guest
      // transfers its bridge and reports failures once, without retry/ack.
      window.addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type !== "multica:plugin-surface-error") return;
        if (event.source !== frame.contentWindow) return;
        (window as unknown as { __surfaceErrors: number }).__surfaceErrors++;
      });
      frame.srcdoc = srcdoc;
    }, documentWithError);

    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __surfaceErrors: number }).__surfaceErrors,
    )).toBe(1);
  });
});
