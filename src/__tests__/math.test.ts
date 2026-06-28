import { describe, test, expect } from "vitest";
import { add, divide } from "../math";

describe("add", () => {
  test("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
  test("adds a negative number", () => {
    expect(add(5, -2)).toBe(3);
  });
});

describe("divide", () => {
  test("divides two numbers", () => {
    expect(divide(10, 2)).toBe(5);
  });
  test("throws on divide by zero", () => {
    expect(() => divide(1, 0)).toThrow("Cannot divide by zero");
  });
});
