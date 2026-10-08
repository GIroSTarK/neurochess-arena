export function RecoveryNotice({
  title,
  description,
  hint,
}: {
  readonly title: string;
  readonly description: string;
  readonly hint: string;
}) {
  return (
    <div className="border-l-4 border-warning pl-4 text-body">
      <h2 className="font-semibold text-text">{title}</h2>
      <p className="mt-1 text-text-secondary">{description}</p>
      <p className="text-text-secondary">{hint}</p>
    </div>
  );
}
