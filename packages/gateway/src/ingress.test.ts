import { describe, expect, it } from "vitest";
import { IngressKeyError, ingressUrl } from "./ingress.js";

describe("restate ingress url building (0001:A3/0001:A4)", () => {
  it("builds call and send urls", () => {
    expect(
      ingressUrl(
        "http://restate:8080",
        { service: "agent.researcher", key: "r1" },
        "spawn",
        "send",
      ),
    ).toBe("http://restate:8080/agent.researcher/r1/spawn/send");
    expect(
      ingressUrl(
        "http://restate:8080",
        { service: "agent.researcher", key: "r1" },
        "message",
        "call",
      ),
    ).toBe("http://restate:8080/agent.researcher/r1/message");
  });

  it("percent-encodes url-shaped keys (0001:A3: raw slash in an ingress path is a 400)", () => {
    const url = ingressUrl(
      "http://restate:8080",
      { service: "steer", key: "/t/default/a/researcher/r1" },
      "push",
      "send",
    );
    expect(url).toBe("http://restate:8080/steer/%2Ft%2Fdefault%2Fa%2Fresearcher%2Fr1/push/send");
    expect(url).not.toContain("//t/"); // no raw slash from the key survives
  });

  it("rejects empty keys (0001:A3: gateway must reject empty Restate keys)", () => {
    expect(() =>
      ingressUrl("http://restate:8080", { service: "agent.researcher", key: "" }, "spawn", "send"),
    ).toThrow(IngressKeyError);
  });
});
