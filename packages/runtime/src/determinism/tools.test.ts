import { describe, expect, it, vi } from "vitest";

import { createPlaygroundTools, createRandomGenerator } from "./tools.ts";

describe("playground tools", () => {
  it("should preserve the helper draw order and values for seed 123", () => {
    const { random } = createPlaygroundTools({ seed: 123, display() {} });

    expect({
      integer: random.integer(),
      reversed: random.integer(10, -4),
      uuid: random.uuid(),
      firstName: random.firstName(),
      lastName: random.lastName(),
      fullName: random.fullName(),
      decimal: random.decimal(),
      boundedDecimal: random.decimal(-5, 7),
      lorem: random.lorem(),
      email: random.email(),
      date: random.date().toISOString(),
      url: random.url(),
      imageUrl: random.imageUrl(),
      sequence: random.sequence(4),
      array: random.array(3, (_, index) => index * 2),
      next: random.integer(),
    }).toEqual({
      integer: 787_251,
      reversed: -2,
      uuid: "7e3b60d5-dded-4868-9dfd-3002975a8596",
      firstName: "Grace",
      lastName: "Hamilton",
      fullName: "Edsger Lovelace",
      decimal: "4.08",
      boundedDecimal: "-3.65",
      lorem: "amet adipiscing dolor amet elit consectetur elit lorem",
      email: "margaret.torvalds815@example.test",
      date: "2014-01-16T02:59:44.349Z",
      url: "https://example.test/8932ed96-3941-4675-98f1-7e5413579805",
      imageUrl: "https://images.example.test/8d79cc4d-e42b-4fda-8c87-692c26f2bccf.webp",
      sequence: [1, 2, 3, 4],
      array: [0, 2, 4],
      next: 333_565,
    });
  });

  it("should maintain independent unsigned-seed streams", () => {
    const first = createRandomGenerator(123);
    const second = createRandomGenerator(123 + 2 ** 32);
    const expected = [
      0.7872516233474016, 0.1785435655619949, 0.49531551403924823, 0.23136196262203157, 0.375791602069512,
    ];

    expect(Array.from({ length: 5 }, first)).toEqual(expected);
    expect(Array.from({ length: 5 }, second)).toEqual(expected);
  });

  it("should preserve display validation, values, and immutable helper surfaces", () => {
    const display = vi.fn();
    const tools = createPlaygroundTools({ seed: 1, display });

    expect(() => tools.display(" ", 1)).toThrow("$.display requires a label and values");
    expect(() => tools.display("Rows")).toThrow("$.display requires a label and values");
    tools.display("Rows", 1, undefined);

    expect(display).toHaveBeenCalledExactlyOnceWith("Rows", [1, undefined]);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(tools.random)).toBe(true);
  });
});
