/**
 * Beautiful UI atom, rebuilt from the compiled bundle at https://www.beautifului.dev
 * (the source is not published). MIT License, Copyright (c) 2026 Shane Levine.
 */
import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const innerHighlight = "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]";

const buttonVariants = cva(
  `inline-flex items-center justify-center font-medium select-none
   transition-[transform,background-color,opacity] duration-150 ease-out
   active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: `bg-ink text-canvas hover:opacity-90 dark:bg-ink dark:text-canvas ${innerHighlight}`,
        secondary: "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
        ghost: "bg-hover-2 text-ink hover:bg-line-strong",
        accent: `bg-accent text-white hover:bg-accent-ink ${innerHighlight}`,
        success: `bg-green text-white hover:brightness-95 ${innerHighlight}`,
        danger: `bg-red text-white hover:brightness-95 ${innerHighlight}`,
        quiet: "text-ink hover:bg-hover",
      },
      size: {
        xs: "h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1",
        sm: "h-[27px] px-3 text-[13px] leading-none rounded-full gap-1.5",
        md: "px-4 py-[9px] text-sm leading-none rounded-full gap-2",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({ variant, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={twMerge(clsx(buttonVariants({ variant, size }), className))} {...rest} />;
}
