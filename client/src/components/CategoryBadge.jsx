export function CategoryBadge({ category }) {
  if (!category) return <span className="badge badge-none">Uncategorized</span>;
  return (
    <span className="badge" style={{ backgroundColor: category.color }}>
      {category.name}
    </span>
  );
}
