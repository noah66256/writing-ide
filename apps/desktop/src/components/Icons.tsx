type SvgProps = {
  size?: number;
};

function baseProps(size = 18) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg"
  } as const;
}

export function IconAt(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M12 5.5a6.5 6.5 0 1 0 0 13h1.2a3.3 3.3 0 0 0 3.3-3.3V12a4.5 4.5 0 1 0-2 3.74"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function IconGlobe(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M3.6 9h16.8M3.6 15h16.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 3c2.6 2.3 4.2 5.6 4.2 9S14.6 18.7 12 21c-2.6-2.3-4.2-5.6-4.2-9S9.4 5.3 12 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconImage(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v11A2.5 2.5 0 0 1 16.5 20h-9A2.5 2.5 0 0 1 5 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8.2 14.7 10.6 12.3c.6-.6 1.5-.6 2.1 0l4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 9.2a1.2 1.2 0 1 0 0-.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconMic(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19 11a7 7 0 0 1-14 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSend(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M12 19V5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M7 10l5-5 5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconStop(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M8 8.5A1.5 1.5 0 0 1 9.5 7h5A1.5 1.5 0 0 1 16 8.5v7A1.5 1.5 0 0 1 14.5 17h-5A1.5 1.5 0 0 1 8 15.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function IconRewind(props: SvgProps) {
  const s = props.size ?? 18;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M8.5 7.5 5 11l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 11h7.2a4.8 4.8 0 0 1 0 9.6H10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconChevronDown(props: SvgProps) {
  const s = props.size ?? 16;
  return (
    <svg {...baseProps(s)}>
      <path
        d="M7 10l5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


