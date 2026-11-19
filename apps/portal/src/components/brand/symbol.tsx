type BrandSymbolProps = {
  className?: string;
  title?: string;
};

export function BrandSymbol({ className, title }: BrandSymbolProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect width="64" height="64" rx="15" className="fill-brand" />
      <rect x="13" y="38" width="8" height="13" rx="2.5" fill="#ffffff" fillOpacity="0.75" />
      <rect x="25" y="30" width="8" height="21" rx="2.5" fill="#ffffff" fillOpacity="0.88" />
      <rect x="37" y="25" width="8" height="26" rx="2.5" fill="#ffffff" />
      <path d="M43 6 Q43 14 51 14 Q43 14 43 22 Q43 14 35 14 Q43 14 43 6 Z" fill="#ffffff" />
    </svg>
  );
}
