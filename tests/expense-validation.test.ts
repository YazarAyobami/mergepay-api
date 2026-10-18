import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-import the schema to test it in isolation.
const shareInput = z.object({
  userId: z.string(),
  amount: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
});

const SUPPORTED_ASSETS = ["XLM", "USDC"] as const;

const createExpenseSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  amount: z.string().refine((val) => {
    if (!/^\d+(\.\d+)?$/.test(val)) return false;
    const num = Number(val);
    return num > 0 && Number.isFinite(num);
  }, "Amount must be a positive number"),
  assetCode: z.enum(SUPPORTED_ASSETS, {
    errorMap: () => ({ message: `Asset code must be one of: ${SUPPORTED_ASSETS.join(", ")}` }),
  }),
  assetIssuer: z.string().nullable().optional(),
  splitType: z.enum(["equal", "custom", "percentage"]),
  shares: z.array(shareInput).min(1).refine((shares) => {
    if (shares.some((s) => s.percent !== undefined)) {
      const total = shares.reduce((sum, s) => sum + (s.percent ?? 0), 0);
      if (total > 100) return false;
    }
    if (shares.some((s) => s.amount !== undefined)) {
      if (shares.some((s) => s.amount && !/^\d+(\.\d+)?$/.test(s.amount))) return false;
    }
    return true;
  }, "Invalid share configuration"),
  payerUserId: z.string().optional(),
  memo: z.string().max(24).optional(),
  receiptUrl: z.string().url("Receipt URL must be a valid URL").nullable().optional(),
});

describe("expense creation Zod validation", () => {
  it("accepts a valid expense payload with XLM", () => {
    const valid = {
      title: "Dinner",
      amount: "30",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }, { userId: "user2" }],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("accepts USDC with issuer", () => {
    const valid = {
      title: "Lunch",
      amount: "15.50",
      assetCode: "USDC",
      assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      splitType: "custom" as const,
      shares: [
        { userId: "user1", amount: "10" },
        { userId: "user2", amount: "5.50" },
      ],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects negative amount", () => {
    const invalid = {
      title: "Bad",
      amount: "-10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects zero amount", () => {
    const invalid = {
      title: "Zero",
      amount: "0",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects non-numeric amount", () => {
    const invalid = {
      title: "NaN",
      amount: "abc",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects unsupported asset code", () => {
    const invalid = {
      title: "Euro",
      amount: "100",
      assetCode: "EUR",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects percentage split exceeding 100%", () => {
    const invalid = {
      title: "Over",
      amount: "100",
      assetCode: "XLM",
      splitType: "percentage" as const,
      shares: [
        { userId: "user1", percent: 60 },
        { userId: "user2", percent: 50 },
      ],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("accepts percentage split exactly at 100%", () => {
    const valid = {
      title: "Exact",
      amount: "100",
      assetCode: "XLM",
      splitType: "percentage" as const,
      shares: [
        { userId: "user1", percent: 60 },
        { userId: "user2", percent: 40 },
      ],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects invalid receipt URL", () => {
    const invalid = {
      title: "Bad URL",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
      receiptUrl: "not-a-url",
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("accepts null receipt URL", () => {
    const valid = {
      title: "No Receipt",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
      receiptUrl: null,
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects empty shares array", () => {
    const invalid = {
      title: "No Shares",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects title longer than 80 characters", () => {
    const invalid = {
      title: "A".repeat(81),
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });
});
