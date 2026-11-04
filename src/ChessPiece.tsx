import React from 'react';

interface ChessPieceProps {
  type: string; // 'p' | 'r' | 'n' | 'b' | 'q' | 'k' | 'P' | 'R' | 'N' | 'B' | 'Q' | 'K'
  className?: string;
}

export const ChessPiece: React.FC<ChessPieceProps> = ({ type, className = "w-10 h-10" }) => {
  const isWhite = type === type.toUpperCase();
  const lower = type.toLowerCase();

  const fill = isWhite ? '#f8fafc' : '#1e293b';
  const stroke = isWhite ? '#334155' : '#0f172a';
  const accent = isWhite ? '#e2e8f0' : '#334155';

  switch (lower) {
    case 'p':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* Pawn */}
          <path
            d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.95 3.84 2.44 5.03C16.89 27.28 15 30.34 15 34h15c0-3.66-1.89-6.72-3.44-7.97C28.05 24.84 29 23.03 29 21c0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 36h21v3H12z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
          />
          <circle cx="22.5" cy="13" r="2" fill={accent} />
        </svg>
      );

    case 'r':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* Rook */}
          <path
            d="M9 39h27v-3H9v3zm3-3v-4.5h21V36H12zm2-4.5c0-4 2-9 2-9h14s2 5 2 9H14z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M14 22.5h17V17H14v5.5zm-3-5.5v-6h3.5v3h4.5v-3h7v3h4.5v-3H34v6H11z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M14 29h17" stroke={stroke} strokeWidth="1.5" />
        </svg>
      );

    case 'n':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* Knight */}
          <path
            d="M22 10c-3 0-5 2-6 5-1 3-2 6-4 8-1 1-2 2-2 4 0 2 1 3 3 3 1 0 2-1 3-2 0 2 1 4 3 5 1.5 1 4 2 6 2 2 0 4-1 5-2 1-1 2-3 2-5 0-3-1-6-1-9 2-1 3-3 3-5 0-2-1-4-3-4h-6zm-4 7c.5 0 1 .5 1 1s-.5 1-1 1-1-.5-1-1 .5-1 1-1z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 39.5h26v-3.5h-26v3.5zm2.5-3.5c1-3 3-5 6-6h9c3 1 5 3 6 6H12z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );

    case 'b':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* Bishop */}
          <circle cx="22.5" cy="8" r="1.5" fill={stroke} />
          <path
            d="M22.5 10c-3.5 0-6.5 3-6.5 8 0 3 1.5 5 2.5 7 1 2 1.5 4 1.5 6h5c0-2 .5-4 1.5-6 1-2 2.5-4 2.5-7 0-5-3-8-6.5-8z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M17.5 25c2 1 4 1 6 1s4 0 6-1"
            stroke={stroke}
            strokeWidth="1.5"
          />
          <path
            d="M11 39h23v-3.5H11V39zm3-3.5c.5-1.5 2-3.5 4-4.5h9c2 1 3.5 3 4 4.5H14z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M22.5 13v6M19.5 16h6" stroke={stroke} strokeWidth="1.5" />
        </svg>
      );

    case 'q':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* Queen */}
          <circle cx="6" cy="12" r="1.5" fill={stroke} />
          <circle cx="14" cy="9" r="1.5" fill={stroke} />
          <circle cx="22.5" cy="8" r="1.5" fill={stroke} />
          <circle cx="31" cy="9" r="1.5" fill={stroke} />
          <circle cx="39" cy="12" r="1.5" fill={stroke} />
          <path
            d="M9 26c1.5-3 3-7 3-10l5 7 5.5-12 5.5 12 5-7c0 3 1.5 7 3 10-2 2-6 3-13.5 3S11 28 9 26z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M9 26c0 2 1.5 4 3.5 5.5h20c2-1.5 3.5-3.5 3.5-5.5H9zm2 8h23v-2.5H11V34zm-2 5h27v-3H9v3z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );

    case 'k':
      return (
        <svg viewBox="0 0 45 45" className={className} fill="none">
          {/* King cross */}
          <path d="M22.5 6v5M20 8.5h5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M22.5 11.5c-4 0-7 2.5-7 6.5 0 2.5 1.5 4.5 3 6 1.5 1.5 2 3 2 5h4c0-2 .5-3.5 2-5 1.5-1.5 3-3.5 3-6 0-4-3-6.5-7-6.5z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M11 39h23v-3.5H11V39zm2.5-3.5c1-2 2.5-3.5 4.5-4.5h9c2 1 3.5 2.5 4.5 4.5h-18z"
            fill={fill}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="22.5" cy="17" r="2" fill={accent} />
        </svg>
      );

    default:
      return null;
  }
};
