export interface DirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export async function selectProjectDirectory(
  showDialog: () => Promise<DirectoryDialogResult>,
): Promise<string | null> {
  const result = await showDialog();
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}
