export function CategoryBadge({ category }) {
  if (!category) return <span className="badge badge-none">Uncategorised</span>;
  return (
    <span className="badge" style={{ backgroundColor: category.color }}>
      {category.name}
    </span>
  );
}
