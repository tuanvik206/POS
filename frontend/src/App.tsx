import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowDownToLine, BarChart3, Box, ChevronDown, CircleDollarSign, ClipboardList, LogOut, Package, Plus, Search, ShoppingCart, Trash2, TrendingUp, Users, X } from 'lucide-react';

type User = { id: number; username: string; name: string; role: 'admin'|'cashier' };
type Product = { id:number; sku:string; name:string; category:string|null; price:number; stock:number; reorder_level:number };
type Order = { id:number; receipt_no:string; total:number; payment_method:string; created_at:string; cashier:string };
type Summary = { product_count:number; unit_count:number; low_stock_count:number; sale_count:number; revenue:number; recent:Order[] };
type CartLine = Product & { quantity:number };
const currency = (n:number) => new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(n);
const date = (d:string) => new Date(d).toLocaleString('vi-VN',{dateStyle:'short',timeStyle:'short'});
const paymentLabels:Record<string,string>={cash:'Tiền mặt',card:'Thẻ',transfer:'Chuyển khoản'};

function App() {
  const [token,setToken] = useState(localStorage.getItem('pos_token') || '');
  const [user,setUser] = useState<User|null>(()=>{ try { return JSON.parse(localStorage.getItem('pos_user')||'null'); } catch { return null; } });
  const [page,setPage] = useState('overview');
  const [summary,setSummary] = useState<Summary|null>(null);
  const [products,setProducts] = useState<Product[]>([]);
  const [orders,setOrders] = useState<Order[]>([]);
  const [search,setSearch] = useState('');
  const [cart,setCart] = useState<CartLine[]>([]);
  const [notice,setNotice] = useState('');
  const [showForm,setShowForm] = useState(false);
  const [newProduct,setNewProduct] = useState({sku:'',name:'',price:'',stock:'0',reorder_level:'5'});
  const [payment,setPayment] = useState('cash');
  const [loading,setLoading] = useState(false);
  const api = useCallback(async (path:string,options:RequestInit={}) => {
    const response = await fetch(path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ } ),...(options.headers||{})}});
    const data = await response.json().catch(()=>({}));
    if(response.status===401 && token){ logout(); throw new Error('Phiên đăng nhập hết hạn.'); }
    if(!response.ok) throw new Error(data.error || 'Có lỗi xảy ra.');
    return data;
  },[token]);
  const refresh = useCallback(async()=>{
    if(!token) return;
    const [s,p,o] = await Promise.all([api('/api/v1/dashboard'),api('/api/v1/products'),api('/api/v1/orders')]);
    setSummary(s); setProducts(p); setOrders(o);
  },[api,token]);
  useEffect(()=>{ refresh().catch((e)=>setNotice(e.message)); },[refresh]);
  useEffect(()=>{ if(!notice)return; const t=setTimeout(()=>setNotice(''),3500); return()=>clearTimeout(t); },[notice]);
  function logout(){ localStorage.removeItem('pos_token');localStorage.removeItem('pos_user');setToken('');setUser(null);setCart([]); }
  async function login(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setLoading(true);setNotice('');
    const form=new FormData(e.currentTarget);
    try{const data=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});
      localStorage.setItem('pos_token',data.token);localStorage.setItem('pos_user',JSON.stringify(data.user));setToken(data.token);setUser(data.user);}
    catch(err){setNotice((err as Error).message);}finally{setLoading(false);}
  }
  async function createProduct(e:FormEvent<HTMLFormElement>){
    e.preventDefault();try{await api('/api/v1/products',{method:'POST',body:JSON.stringify({...newProduct,price:Number(newProduct.price),stock:Number(newProduct.stock),reorder_level:Number(newProduct.reorder_level)})});setShowForm(false);setNewProduct({sku:'',name:'',price:'',stock:'0',reorder_level:'5'});await refresh();setNotice('Đã thêm sản phẩm.');}catch(err){setNotice((err as Error).message);}
  }
  async function adjust(product:Product,delta:number){
    try{await api('/api/v1/inventory/adjust',{method:'POST',body:JSON.stringify({product_id:product.id,change_qty:delta,reason:delta>0?'restock':'correction'})});await refresh();setNotice('Đã cập nhật tồn kho.');}catch(err){setNotice((err as Error).message);}
  }
  function addToCart(product:Product){setCart((old)=>{const found=old.find(x=>x.id===product.id);if(found)return old.map(x=>x.id===product.id?{...x,quantity:Math.min(x.quantity+1,product.stock)}:x);return [...old,{...product,quantity:1}];});}
  async function checkout(){
    if(!cart.length)return;setLoading(true);
    try{const receipt=await api('/api/v1/checkout',{method:'POST',body:JSON.stringify({items:cart.map(x=>({product_id:x.id,quantity:x.quantity})),payment_method:payment,discount:0})});setCart([]);await refresh();setPage('orders');setNotice(`Thanh toán thành công · ${receipt.receipt_no} · ${currency(receipt.total)}`);}catch(err){setNotice((err as Error).message);}finally{setLoading(false);}
  }
  const filtered=useMemo(()=>products.filter(p=>`${p.name} ${p.sku} ${p.category||''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())),[products,search]);
  if(!token||!user)return <main className="login-shell"><div className="login-card"><div className="brand-mark"><ShoppingCart size={22}/></div><p className="eyebrow">POS STORE · QUẢN LÝ CỬA HÀNG</p><h1>Chào mừng trở lại</h1><p className="muted">Đăng nhập để quản lý bán hàng và tồn kho.</p><form onSubmit={login} className="login-form"><label>Tên đăng nhập<input name="username" required autoComplete="username" placeholder="admin"/></label><label>Mật khẩu<input name="password" type="password" required autoComplete="current-password" placeholder="Nhập mật khẩu"/></label><button className="primary wide" disabled={loading}>{loading?'Đang đăng nhập…':'Đăng nhập'}</button></form><small className="muted">Thông tin quản trị được tạo khi chạy <code>npm run setup</code>.</small></div>{notice&&<div className="toast error">{notice}</div>}</main>;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><ShoppingCart size={20}/></div><div><b>POS STORE</b><small>Quản lý bán hàng</small></div></div><div className="store-label">CỬA HÀNG · 01</div><nav>
      <button className={page==='overview'?'selected':''} onClick={()=>setPage('overview')}><BarChart3/>Tổng quan</button>
      <button className={page==='pos'?'selected':''} onClick={()=>setPage('pos')}><ShoppingCart/>Bán hàng <span className="nav-count">{cart.reduce((n,x)=>n+x.quantity,0)||''}</span></button>
      <button className={page==='products'?'selected':''} onClick={()=>setPage('products')}><Package/>Sản phẩm & kho</button>
      <button className={page==='orders'?'selected':''} onClick={()=>setPage('orders')}><ClipboardList/>Hóa đơn</button>
    </nav><div className="side-bottom"><div className="health"><span className="green-dot"/> Hệ thống đang hoạt động</div><a href="/grafana/" target="_blank" rel="noreferrer"><Activity/>Giám sát hệ thống</a><div className="user-card"><div className="avatar">{user.name.slice(0,1)}</div><div className="user-meta"><b>{user.name}</b><small>{user.role==='admin'?'Quản trị viên':'Thu ngân'}</small></div><button className="icon-btn" title="Đăng xuất" onClick={logout}><LogOut size={17}/></button></div></div></aside>
    <main className="main-area"><header className="topbar"><div><span className="muted">Cửa hàng / </span><b>{({overview:'Tổng quan',pos:'Bán hàng',products:'Sản phẩm & kho',orders:'Hóa đơn'} as Record<string,string>)[page]}</b></div><div className="top-actions"><span className="today">{new Date().toLocaleDateString('vi-VN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}</span><button className="avatar small" title={user.name}>{user.name.slice(0,1)}</button></div></header>
      {page==='overview'&&<section className="page"><div className="page-heading"><div><p className="eyebrow">BẢNG ĐIỀU KHIỂN</p><h1>Tổng quan cửa hàng</h1><p className="muted">Tình hình kinh doanh hôm nay.</p></div><button className="secondary" onClick={()=>refresh()}><Activity size={16}/> Làm mới</button></div>
        <div className="stats-grid"><Stat icon={<CircleDollarSign/>} label="Doanh thu hôm nay" value={currency(summary?.revenue||0)} sub={`${summary?.sale_count||0} hóa đơn`} tone="blue"/><Stat icon={<Package/>} label="Sản phẩm đang bán" value={String(summary?.product_count||0)} sub={`${summary?.unit_count||0} sản phẩm trong kho`} tone="violet"/><Stat icon={<TrendingUp/>} label="Số hóa đơn hôm nay" value={String(summary?.sale_count||0)} sub="Tất cả phương thức thanh toán" tone="green"/><Stat icon={<Box/>} label="Sắp hết hàng" value={String(summary?.low_stock_count||0)} sub="Chạm ngưỡng nhập thêm" tone="orange"/></div>
        <div className="content-grid"><div className="panel"><div className="panel-head"><div><h2>Giao dịch gần đây</h2><p className="muted">Các hóa đơn mới nhất</p></div><button className="text-btn" onClick={()=>setPage('orders')}>Xem tất cả →</button></div><OrderTable orders={summary?.recent||[]}/></div><div className="panel quick-panel"><h2>Truy cập nhanh</h2><p className="muted">Các công việc thường dùng</p><button className="quick-link" onClick={()=>setPage('pos')}><span className="quick-icon blue"><ShoppingCart/></span><span><b>Tạo hóa đơn mới</b><small>Bắt đầu phiên bán hàng</small></span><span>→</span></button><button className="quick-link" onClick={()=>setPage('products')}><span className="quick-icon violet"><Package/></span><span><b>Quản lý sản phẩm</b><small>Cập nhật giá và số lượng</small></span><span>→</span></button><a className="quick-link" href="/phpmyadmin/" target="_blank" rel="noreferrer"><span className="quick-icon orange"><Activity/></span><span><b>Mở phpMyAdmin</b><small>Quản trị cơ sở dữ liệu</small></span><span>↗</span></a></div></div>
      </section>}
      {page==='products'&&<section className="page"><div className="page-heading"><div><p className="eyebrow">DANH MỤC HÀNG HÓA</p><h1>Sản phẩm & tồn kho</h1><p className="muted">Theo dõi mã hàng, giá bán và số lượng còn lại.</p></div>{user.role==='admin'&&<button className="primary" onClick={()=>setShowForm(true)}><Plus size={17}/> Thêm sản phẩm</button>}</div><div className="toolbar"><div className="search-box"><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tìm theo tên hoặc mã SKU…"/></div><span className="muted">{filtered.length} sản phẩm</span></div><div className="panel table-panel"><table><thead><tr><th>SẢN PHẨM</th><th>MÃ SKU</th><th>GIÁ BÁN</th><th>TỒN KHO</th><th>TRẠNG THÁI</th>{user.role==='admin'&&<th>ĐIỀU CHỈNH</th>}</tr></thead><tbody>{filtered.map(p=><tr key={p.id}><td><b>{p.name}</b><small className="table-sub">{p.category||'Chưa phân loại'}</small></td><td><code>{p.sku}</code></td><td>{currency(p.price)}</td><td><b>{p.stock}</b></td><td><span className={`badge ${p.stock<=p.reorder_level?'warning':'success'}`}>{p.stock<=p.reorder_level?'Sắp hết':'Còn hàng'}</span></td>{user.role==='admin'&&<td><div className="adjust"><button onClick={()=>adjust(p,-1)} disabled={p.stock===0}>−</button><button onClick={()=>adjust(p,1)}>+</button></div></td>}</tr>)}</tbody></table>{filtered.length===0&&<div className="empty">Chưa có sản phẩm phù hợp.</div>}</div></section>}
      {page==='pos'&&<section className="page"><div className="page-heading"><div><p className="eyebrow">ĐIỂM BÁN HÀNG</p><h1>Tạo hóa đơn</h1><p className="muted">Chọn sản phẩm, xác nhận số lượng và thanh toán.</p></div><div className="receipt-chip"><span className="green-dot"/> Phiên bán hàng mới</div></div><div className="pos-layout"><div className="panel product-picker"><div className="search-box"><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tìm sản phẩm…"/></div><div className="product-grid">{filtered.map(p=><button className="product-card" key={p.id} onClick={()=>addToCart(p)} disabled={p.stock<1}><span className="product-icon"><Package/></span><span className="product-title">{p.name}</span><code>{p.sku}</code><b>{currency(p.price)}</b><small className={p.stock<=p.reorder_level?'stock-low':''}>Còn {p.stock}</small></button>)}</div>{filtered.length===0&&<div className="empty">Chưa có hàng. Hãy thêm sản phẩm trong mục Sản phẩm & kho.</div>}</div><div className="panel cart-panel"><div className="panel-head"><div><h2>Giỏ hàng</h2><p className="muted">{cart.reduce((n,x)=>n+x.quantity,0)} mặt hàng</p></div><button className="icon-btn" title="Xóa giỏ" onClick={()=>setCart([])}><Trash2 size={17}/></button></div><div className="cart-lines">{cart.map(line=><div className="cart-line" key={line.id}><div className="cart-product"><b>{line.name}</b><small>{currency(line.price)}</small></div><div className="qty"><button onClick={()=>setCart(c=>c.map(x=>x.id===line.id?{...x,quantity:Math.max(1,x.quantity-1)}:x))}>−</button><span>{line.quantity}</span><button disabled={line.quantity>=line.stock} onClick={()=>setCart(c=>c.map(x=>x.id===line.id?{...x,quantity:x.quantity+1}:x))}>+</button></div><b>{currency(line.price*line.quantity)}</b></div>)}{!cart.length&&<div className="empty cart-empty"><ShoppingCart/><p>Chưa có sản phẩm trong đơn</p><small>Chọn sản phẩm ở danh sách bên trái</small></div>}</div><div className="cart-total"><label>Phương thức thanh toán<select value={payment} onChange={e=>setPayment(e.target.value)}><option value="cash">Tiền mặt</option><option value="card">Thẻ</option><option value="transfer">Chuyển khoản</option></select></label><div className="total-row"><span>Tạm tính</span><b>{currency(cart.reduce((n,x)=>n+x.price*x.quantity,0))}</b></div><div className="total-row final"><span>Khách cần trả</span><b>{currency(cart.reduce((n,x)=>n+x.price*x.quantity,0))}</b></div><button className="primary wide" disabled={!cart.length||loading} onClick={checkout}><CircleDollarSign size={18}/>{loading?'Đang xử lý…':'Hoàn tất thanh toán'}</button></div></div></div></section>}
      {page==='orders'&&<section className="page"><div className="page-heading"><div><p className="eyebrow">LỊCH SỬ GIAO DỊCH</p><h1>Hóa đơn bán hàng</h1><p className="muted">Danh sách 100 hóa đơn gần nhất.</p></div><button className="secondary" onClick={()=>refresh()}><Activity size={16}/> Làm mới</button></div><div className="panel table-panel"><OrderTable orders={orders}/></div></section>}
    </main>
    {showForm&&<div className="modal-backdrop" onClick={()=>setShowForm(false)}><form className="modal" onClick={e=>e.stopPropagation()} onSubmit={createProduct}><div className="modal-head"><div><p className="eyebrow">DANH MỤC</p><h2>Thêm sản phẩm</h2></div><button type="button" className="icon-btn" onClick={()=>setShowForm(false)}><X/></button></div><label>Mã SKU<input required value={newProduct.sku} onChange={e=>setNewProduct({...newProduct,sku:e.target.value})} placeholder="VD: SP-001"/></label><label>Tên sản phẩm<input required value={newProduct.name} onChange={e=>setNewProduct({...newProduct,name:e.target.value})} placeholder="Tên hàng hóa"/></label><div className="form-row"><label>Giá bán (₫)<input type="number" min="0" required value={newProduct.price} onChange={e=>setNewProduct({...newProduct,price:e.target.value})}/></label><label>Số lượng ban đầu<input type="number" min="0" required value={newProduct.stock} onChange={e=>setNewProduct({...newProduct,stock:e.target.value})}/></label></div><label>Ngưỡng cảnh báo tồn kho<input type="number" min="0" required value={newProduct.reorder_level} onChange={e=>setNewProduct({...newProduct,reorder_level:e.target.value})}/></label><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setShowForm(false)}>Hủy</button><button className="primary"><Plus size={17}/> Lưu sản phẩm</button></div></form></div>}
    {notice&&<div className="toast">{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}
  </div>;
}

function Stat({icon,label,value,sub,tone}:{icon:ReactNode;label:string;value:string;sub:string;tone:string}){return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-sub">{sub}</div></div>}
function OrderTable({orders}:{orders:Order[]}){return <div className="table-wrap"><table><thead><tr><th>MÃ HÓA ĐƠN</th><th>THỜI GIAN</th><th>THU NGÂN</th><th>THANH TOÁN</th><th>TỔNG TIỀN</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td><span className="receipt-id">{o.receipt_no}</span></td><td>{date(o.created_at)}</td><td>{o.cashier}</td><td><span className="badge neutral">{paymentLabels[o.payment_method]||o.payment_method}</span></td><td><b>{currency(o.total)}</b></td></tr>)}</tbody></table>{orders.length===0&&<div className="empty">Chưa có hóa đơn.</div>}</div>}

export default App;
