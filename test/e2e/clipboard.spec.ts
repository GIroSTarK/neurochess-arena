import { expectClipboardCopy } from "./clipboard";
import { expect, test } from "./fixtures";

test("clipboard assertion failures do not disclose copied or expected private text", async ({
  page,
  browserName,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Copy clipboard fixture";
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText("actual-private-clipboard-fixture");
    });
    document.body.append(button);
  });
  let diagnostic = "";
  try {
    await expectClipboardCopy(
      page,
      page.getByRole("button", { name: "Copy clipboard fixture", exact: true }),
      "expected-private-clipboard-fixture",
      browserName,
    );
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : "";
  }
  expect(
    await page.evaluate(
      () => Reflect.get(window, "acceptedClipboardWrite") === "actual-private-clipboard-fixture",
    ),
  ).toBe(true);
  expect(diagnostic.length > 0).toBe(true);
  expect(diagnostic.includes("private-clipboard-fixture")).toBe(false);
});
