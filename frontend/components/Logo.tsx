/**
 * Waypoint Logo Component
 *
 * A cairn - three stacked, slightly offset stones, tonally graduated dark
 * to light from base to peak. This is the literal, universal trail-marker
 * object "waypoint" refers to, and it doubles as the visual language for
 * the whole lifecycle: each stage in an engagement's trail is a disk that
 * fills brass once reached, exactly like a hiker marking a route.
 */

import React from "react";
import { CairnGlyph } from "./CairnGlyph";

export type LogoVariant = "full" | "mark" | "wordmark";
export type LogoSize = "sm" | "md" | "lg";

interface LogoProps {
  variant?: LogoVariant;
  size?: LogoSize;
  className?: string;
}

const sizeMap = {
  sm: 34,
  md: 46,
  lg: 58,
};

function CairnMark({ size }: { size: number }) {
  return (
    <span className="shrink-0 inline-flex" aria-label="Waypoint">
      <CairnGlyph size={size} tone="brass" />
    </span>
  );
}

export function Logo({ variant = "full", size = "md", className = "" }: LogoProps) {
  const markSize = sizeMap[size];

  const Wordmark = () => (
    <div className="leading-none">
      <span className="font-head uppercase text-foreground" style={{ fontSize: "1.15rem", letterSpacing: "0.03em" }}>
        Waypoint
      </span>
      <div className="mt-0.5 font-mono text-[0.58rem] text-muted-foreground" style={{ letterSpacing: "0.08em" }}>
        Verified Milestone Escrow
      </div>
    </div>
  );

  if (variant === "mark") {
    return <div className={`inline-flex items-center ${className}`}><CairnMark size={markSize} /></div>;
  }
  if (variant === "wordmark") {
    return <div className={`inline-flex items-center ${className}`}><Wordmark /></div>;
  }
  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <CairnMark size={markSize} />
      <Wordmark />
    </div>
  );
}

export function LogoFull(props: Omit<LogoProps, "variant">) {
  return <Logo {...props} variant="full" />;
}

export function LogoMark(props: Omit<LogoProps, "variant">) {
  return <Logo {...props} variant="mark" />;
}

export function LogoWordmark(props: Omit<LogoProps, "variant">) {
  return <Logo {...props} variant="wordmark" />;
}
