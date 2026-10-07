import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';

export function Categories() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4f8ef7');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = () => api.getCategories(token).then(setCategories).catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return;
    try {
      await api.createCategory(token, { name, color });
      setName('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    await api.deleteCategory(token, id);
    load();
  };

  const handleSave = async () => {
    setError('');
    if (!editing.name.trim()) {
      setError('Category name is required');
      return;
    }
    try {
      await api.updateCategory(token, editing.id, { name: editing.name, color: editing.color });
      setEditing(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="page">
      <h1>Categories</h1>
      <form className="category-form" onSubmit={handleAdd}>
        <input type="text" placeholder="Category name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="category-list">
        {categories.map((c) =>
          editing?.id === c.id ? (
            <li key={c.id}>
              <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
              <button onClick={handleSave}>Save</button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </li>
          ) : (
            <li key={c.id}>
              <span className="badge" style={{ backgroundColor: c.color }}>{c.name}</span>
              <button onClick={() => setEditing({ ...c })}>Edit</button>
              <button onClick={() => handleDelete(c.id)}>Delete</button>
            </li>
          )
        )}
      </ul>
    </div>
  );
}
