import { Type, type Static } from "@earendil-works/pi-ai";

export const CompletionDeliverySchema = Type.Union(
  [Type.Literal("steer"), Type.Literal("followUp")],
  {
    default: "steer",
    description: "Use steer to get results as soon as they are ready. Use followUp for lower-priority tasks that should be investigated after other work is finished. Defaults to steer."
  }
);

export type CompletionDelivery = Static<typeof CompletionDeliverySchema>;

export function resolveCompletionDelivery(value: CompletionDelivery | undefined): CompletionDelivery {
  return value ?? "steer";
}
