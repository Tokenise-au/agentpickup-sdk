/**
 * How the order was paid: card checkout, x402, MPP, or through an agent checkout protocol (UCP, ACP). "group" is a
 * group order's combined order: each person paid their own share, as an order of their own.
 */
/** "square": a card paid on the shop's Square, through its connector's checkout page. */
export type PaymentRail = "card" | "x402" | "mpp" | "ucp" | "acp" | "test" | "group" | "square";

/**
 * awaiting_payment → paid → (ready) → collected
 *                         ↘ expired (hold released, or refund owed)
 * awaiting_payment → cancelled
 */
export type OrderStatus = "awaiting_payment" | "paid" | "ready" | "collected" | "expired" | "cancelled";

/** "hold" takes the money at handover (card holds); "charge" takes it at order time. */
export type CaptureMode = "hold" | "charge";

/** One choice in an item's option group: "Oat milk", +80c. */
export interface ItemOption {
  id: string;
  name: string;
  /** Added to the item's price; 0 for a free choice. */
  priceCents: number;
  /** Chosen when the customer picks nothing in its group (the POS's own default). */
  default?: boolean;
  soldOut?: boolean;
}

/** A menu item's options: "Milk" (pick one), "Extras" (pick any). */
export interface ItemOptionGroup {
  id: string;
  name: string;
  /** At least this many (1 = a choice is required). */
  min: number;
  /** At most this many; null for no limit. */
  max: number | null;
  options: ItemOption[];
}

/** An option chosen on an order line, priced when the order was made. */
export interface ChosenOption {
  id: string;
  name: string;
  priceCents: number;
}

export interface OrderItem {
  id: string;
  name: string;
  qty: number;
  /** The item's price with its chosen options. */
  unitCents: number;
  /** The options chosen for this line (oat milk, an extra shot), each priced in unitCents. */
  options?: ChosenOption[];
  /** Shown to staff beside the item, e.g. "for Sam" on a group order's combined order. */
  note?: string;
  /** The menu item's category when it was ordered, for the shop's insights. */
  category?: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  rail: PaymentRail;
  captureMode: CaptureMode;
  items: OrderItem[];
  totalCents: number;
  currency: string;
  customerEmail: string | null;
  customerName: string | null;
  /** The customer's dietary note for the shop (an allergy, an intolerance), in their words. */
  dietaryNote?: string | null;
  /** When the customer will collect (Unix ms); null or absent is as soon as possible. */
  pickupAt?: number | null;
  /** Stripe PaymentIntent id, or the settlement transaction hash for x402. */
  paymentRef: string | null;
  /** Wallet address for x402 payers. */
  payer: string | null;
  passId: string | null;
  pickupCode: string | null;
  /** Unix ms. After this the order expires and the hold is released. */
  collectBy: number;
  createdAt: number;
  paidAt: number | null;
  readyAt: number | null;
  collectedAt: number | null;
  /** True when money was taken but the order was never collected. */
  refundDue: boolean;
  /**
   * What an x402 payer pays, in US cents, fixed when the order was created. Set only when the shop prices
   * in another currency; otherwise x402 pays totalCents.
   */
  usdCents?: number | null;
}

export type CollectEventType =
  | "order.created"
  | "order.paid"
  | "order.ready"
  | "order.collected"
  | "order.expired"
  | "order.cancelled"
  | "order.refunded"
  | "pass.emailed";

export interface CollectEvent {
  id: string;
  type: CollectEventType;
  orderId: string;
  at: number;
  data?: Record<string, unknown>;
}
