const NON_CODE_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^LICENSE(\..*)?$/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /^\.editorconfig$/,
  /\.(png|jpg|jpeg|gif|svg|ico|webp)$/i,
  /\.(woff2?|ttf|eot)$/i,
];

export function isNonCodeFile(filePath: string): boolean {
  return NON_CODE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function shouldDropEvent(changedFilePaths: string[]): boolean {
  if (changedFilePaths.length === 0) return true;
  return changedFilePaths.every(isNonCodeFile);
}
