// Visible trust answers in the seat view: the section lists each dialog
// OpenRig answered for the seat's current launch and renders nothing otherwise.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrustAnswersSection } from "../src/components/LiveNodeDetails.js";
import type { NodeDetailData } from "../src/hooks/useNodeDetail.js";

afterEach(() => cleanup());

const ANSWER = {
  code: "trust_gate", option: "Yes", folder: "/work/repo", runtime: "copilot",
  answeredAt: "2026-10-03T03:30:00.000Z", summary: "OpenRig trusted /work/repo for this session (copilot)",
};

describe("TrustAnswersSection", () => {
  it("lists each answer with its time", () => {
    render(<TrustAnswersSection data={{ trustAnswers: [ANSWER] } as unknown as NodeDetailData} />);
    expect(screen.getByTestId("detail-trust-answers")).toBeTruthy();
    expect(screen.getByTestId("detail-trust-answer").textContent).toBe(
      "OpenRig trusted /work/repo for this session (copilot) at 2026-10-03T03:30:00.000Z",
    );
  });

  it("renders nothing when there were no answers or the daemon sent none", () => {
    for (const data of [{ trustAnswers: [] }, {}]) {
      const { container } = render(<TrustAnswersSection data={data as unknown as NodeDetailData} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });
});
