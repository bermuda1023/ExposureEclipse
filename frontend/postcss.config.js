// Empty local PostCSS config — short-circuits Vite/PostCSS's parent-directory
// search so it doesn't accidentally pick up the Tailwind config that lives at
// C:\Users\James\ (from an unrelated project). Add real plugins here if/when
// the project ever needs them.
export default { plugins: {} };
