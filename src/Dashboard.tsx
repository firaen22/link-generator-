import React, { useEffect, useState } from 'react';
import { BarChart3, Users, Clock, FileText, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Dashboard() {
    const [data, setData] = useState<any>(null);

    useEffect(() => {
        fetch('/api/dashboard-stats').then(res => res.json()).then(setData);
    }, []);

    if (!data) return <div className="p-10 text-center">載入中...</div>;

    return (
        <div className="min-h-screen bg-slate-50 p-6 md:p-12">
            <div className="max-w-6xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <Link to="/" className="text-indigo-600 flex items-center gap-1 text-sm font-medium mb-2 hover:underline">
                            <ArrowLeft className="w-4 h-4" /> 返回產生器
                        </Link>
                        <h1 className="text-3xl font-bold text-slate-900">數據看板</h1>
                    </div>
                    <BarChart3 className="w-10 h-10 text-indigo-600 opacity-20" />
                </div>

                {/* 統計卡片 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                    <StatCard icon={<Users />} label="總閱讀次數" value={data.total_views} color="bg-blue-500" />
                    <StatCard icon={<Clock />} label="平均閱讀時長" value={`${Math.round(data.avg_duration)}s`} color="bg-emerald-500" />
                    <StatCard icon={<FileText />} label="最近報告" value={data.recent_sessions[0]?.report_name || '無'} color="bg-amber-500" />
                </div>

                {/* 最近活動表格 */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="p-6 border-b border-slate-100">
                        <h2 className="font-bold text-slate-800">最近 10 次閱讀紀錄</h2>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-semibold">
                                <tr>
                                    <th className="px-6 py-4">客戶名稱</th>
                                    <th className="px-6 py-4">報告名稱</th>
                                    <th className="px-6 py-4">閱讀進度</th>
                                    <th className="px-6 py-4">停留時間</th>
                                    <th className="px-6 py-4">時間</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {data.recent_sessions.map((s: any) => (
                                    <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-6 py-4 font-medium text-slate-900">{s.client_name}</td>
                                        <td className="px-6 py-4 text-slate-600">{s.report_name}</td>
                                        <td className="px-6 py-4 text-slate-600">{s.max_page} / {s.total_pages} 頁</td>
                                        <td className="px-6 py-4 text-slate-600">{s.duration_sec}s</td>
                                        <td className="px-6 py-4 text-slate-400 text-sm">{new Date(s.timestamp).toLocaleString('zh-HK')}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatCard({ icon, label, value, color }: any) {
    return (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
            <div className={`${color} p-3 rounded-xl text-white`}>{icon}</div>
            <div>
                <p className="text-sm text-slate-500 font-medium">{label}</p>
                <p className="text-2xl font-bold text-slate-900">{value}</p>
            </div>
        </div>
    );
}
