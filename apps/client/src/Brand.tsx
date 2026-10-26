import s from './App.module.css';

export function Brand() {
  return (
    <span className={s.brandLogo}>
      <img
        className={s.brandLight}
        src="/openwebprint-logo.svg"
        alt="openwebprint"
        width={1600}
        height={300}
      />
      <img
        className={s.brandDark}
        src="/openwebprint-logo-dark.svg"
        alt="openwebprint"
        width={1600}
        height={300}
      />
    </span>
  );
}
