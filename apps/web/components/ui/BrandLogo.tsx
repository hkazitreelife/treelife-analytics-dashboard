import React from "react";

export interface TreelifeLogoProps {
  size?: "sm" | "md" | "lg" | "xl" | "auto";
  showTagline?: boolean;
  showText?: boolean;
  className?: string;
  imageClassName?: string;
  variant?: "dark" | "light" | "default";
}

export const TreelifeLogo = ({
  size = "md",
  className = "",
  imageClassName = "",
}: TreelifeLogoProps) => {
  const heightClasses = {
    sm: "h-10 sm:h-12 max-w-[200px]",
    md: "h-13 sm:h-16 max-w-[300px]",
    lg: "h-20 sm:h-26 max-w-[420px]",
    xl: "h-28 sm:h-36 max-w-[560px]",
    auto: "h-full w-auto max-h-full",
  };

  return (
    <div
      className={`inline-flex items-center select-none ${className}`}
    >
      <img
        src="/treelife-ai-logo.png"
        alt="Treelife AI"
        className={`${
          size === "auto" ? "h-full max-h-full" : heightClasses[size]
        } w-auto object-contain drop-shadow-sm transition-transform duration-200 hover:scale-[1.02] ${imageClassName}`}
        onError={(e) => {
          const target = e.currentTarget;
          target.style.display = "none";
          const parent = target.parentElement;
          if (parent && !parent.querySelector(".fallback-svg")) {
            const fallback = document.createElement("span");
            fallback.className =
              "fallback-svg font-black text-2xl text-[color:var(--color-forest)] tracking-tight";
            fallback.innerText = "Treelife AI";
            parent.appendChild(fallback);
          }
        }}
      />
    </div>
  );
};
