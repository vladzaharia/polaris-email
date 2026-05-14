// Thin wrapper around @radix-ui/react-select. The shadcn recipe is verbose;
// we ship a compact pass-through with sensible default styling that Phase I
// can extend.
import * as SelectPrimitive from '@radix-ui/react-select';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = SelectPrimitive.Trigger;
export const SelectContent = SelectPrimitive.Content;
export const SelectLabel = SelectPrimitive.Label;
export const SelectItem = SelectPrimitive.Item;
export const SelectItemText = SelectPrimitive.ItemText;
export const SelectItemIndicator = SelectPrimitive.ItemIndicator;
export const SelectSeparator = SelectPrimitive.Separator;
export const SelectPortal = SelectPrimitive.Portal;
export const SelectViewport = SelectPrimitive.Viewport;
