import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrder, secureEqual } from "./server.js";

const base = {
  name:"Test Customer", phone:"9876543210", method:"pickup", payMode:"half",
  date:"2026-10-10", slot:"Morning 10–12", pin:"", addr:"", coupon:"",
  lines:[{ pid:"diwali-sweet-box", size:0, opts:{}, qty:2 }]
};

test("server calculates the advance and ignores browser prices", () => {
  const order = calculateOrder({ ...base, lines:[{ ...base.lines[0], price:1 }] });
  assert.equal(order.bill.sub, 1798);
  assert.equal(order.total, 1798);
  assert.equal(order.amountDue, 899);
});

test("delivery requires full payment and a serviceable address", () => {
  assert.throws(() => calculateOrder({ ...base, method:"delivery" }), /requires full advance|serviceable delivery/);
});

test("COD limit is enforced by the server", () => {
  assert.throws(() => calculateOrder({ ...base, payMode:"cod", lines:[{ pid:"diwali-hamper", qty:1 }] }), /only available up to/);
});

test("constant-time comparison handles equal and unequal signatures", () => {
  assert.equal(secureEqual("abc", "abc"), true);
  assert.equal(secureEqual("abc", "abd"), false);
  assert.equal(secureEqual("a", "longer"), false);
});
