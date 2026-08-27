import { describe, expect, test } from "bun:test"

function greeting(name: string): string {
  return `Hello, ${name}!`
}

describe("greeting", () => {
  test("greets by name", () => {
    expect(greeting("World")).toBe("Hello, World!")
  })
})
