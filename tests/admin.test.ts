import { test, expect } from "bun:test";
import { openAdminStore } from "../src/engine/admin";

test("the first caller claims admin", () => {
  const a = openAdminStore(":memory:");
  expect(a.adminId()).toBeUndefined();
  expect(a.claimAdmin(111)).toBe(true);
  expect(a.adminId()).toBe(111);
});

test("a different caller is rejected once admin is claimed; the first stays admin", () => {
  const a = openAdminStore(":memory:");
  a.claimAdmin(111);
  expect(a.claimAdmin(222)).toBe(false);
  expect(a.adminId()).toBe(111);
});

test("claimAdmin is idempotent for the same admin id", () => {
  const a = openAdminStore(":memory:");
  a.claimAdmin(111);
  expect(a.claimAdmin(111)).toBe(true);
  expect(a.adminId()).toBe(111);
});

test("isAdmin reflects the claimed admin", () => {
  const a = openAdminStore(":memory:");
  a.claimAdmin(111);
  expect(a.isAdmin(111)).toBe(true);
  expect(a.isAdmin(222)).toBe(false);
});
