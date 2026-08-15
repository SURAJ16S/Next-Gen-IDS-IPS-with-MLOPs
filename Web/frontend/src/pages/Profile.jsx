import { useEffect, useState, useCallback } from 'react';
import { getGithubStatus, getGithubUserProfile, getGithubBranches, getGithubAuthUrl, unlinkGithub } from '../services/api';
import {
  User, Mail, Shield, ShieldCheck, MapPin, Briefcase, Link2,
  Users, BookOpen, Star, GitBranch, RefreshCw, LogOut, ChevronRight
} from 'lucide-react';

function Profile() {
  const [user, setUser] = useState(null);
  const [githubLinked, setGithubLinked] = useState(false);
  const [githubData, setGithubData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Repos branch selector
  const [expandedRepo, setExpandedRepo] = useState(null);
  const [branches, setBranches] = useState({});
  const [branchesLoading, setBranchesLoading] = useState({});

  const fetchProfileData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // 1. Load user from localStorage
      const userStr = localStorage.getItem('user');
      if (userStr) {
        setUser(JSON.parse(userStr));
      }

      // 2. Load GitHub link status
      const statusRes = await getGithubStatus();
      const linked = statusRes.data.linked;
      setGithubLinked(linked);

      if (linked) {
        // 3. Load full GitHub profile
        const profileRes = await getGithubUserProfile();
        setGithubData(profileRes.data);
      }
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.message || 'Failed to load profile details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfileData();
  }, [fetchProfileData]);

  // Connect GitHub
  const handleConnectGithub = async () => {
    try {
      const res = await getGithubAuthUrl();
      const popup = window.open(res.data.url, 'github-oauth', 'width=600,height=700,scrollbars=yes');
      const poll = setInterval(() => {
        try {
          if (!popup || popup.closed) {
            clearInterval(poll);
            fetchProfileData();
          }
        } catch (_) {}
      }, 500);
    } catch (_) {
      alert('Failed to initiate GitHub connect.');
    }
  };

  // Unlink GitHub
  const handleUnlink = async () => {
    if (!window.confirm('Disconnect your GitHub account? All associated repository data and charts will be hidden.')) return;
    try {
      await unlinkGithub();
      setGithubLinked(false);
      setGithubData(null);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to unlink account.');
    }
  };

  // Toggle repository branches list
  const toggleRepoBranches = async (fullName) => {
    if (expandedRepo === fullName) {
      setExpandedRepo(null);
      return;
    }

    setExpandedRepo(fullName);
    if (branches[fullName]) return; // already loaded

    setBranchesLoading(prev => ({ ...prev, [fullName]: true }));
    try {
      const [owner, repo] = fullName.split('/');
      const res = await getGithubBranches(owner, repo);
      setBranches(prev => ({ ...prev, [fullName]: res.data }));
    } catch (_) {
      setBranches(prev => ({ ...prev, [fullName]: [{ name: 'main' }] })); // fallback
    } finally {
      setBranchesLoading(prev => ({ ...prev, [fullName]: false }));
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-secondary)', padding: '24px' }}>Loading profile information...</div>;
  }

  const ghProfile = githubData?.profile || null;
  const ghRepos = githubData?.repos || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      
      {/* Page Title */}
      <div>
        <h1 className="page-title">User Profile</h1>
        <p className="page-subtitle">Manage your local account details and connected GitHub developer integration settings</p>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', padding: '14px', borderRadius: 'var(--radius-md)', color: 'var(--sev-critical)', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {/* Grid Layout: Left Column (Profile Info) | Right Column (GitHub Data) */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', alignItems: 'start' }}>
        
        {/* Left Column ── Profile Card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', textAlign: 'center', padding: '28px 20px' }}>
          <div style={{
            width: '80px', height: '80px', borderRadius: '50%',
            background: 'var(--grad-brand)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '32px', fontWeight: 800, textTransform: 'uppercase',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)'
          }}>
            {user?.firstName?.[0] || user?.username?.[0] || '?'}
          </div>
          
          <div>
            <h2 style={{ fontSize: '18px', margin: '0 0 4px', color: 'var(--text-primary)' }}>
              {user?.firstName} {user?.lastName || ''}
            </h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>@{user?.username}</p>
          </div>

          <div style={{ width: '100%', height: '1px', background: 'var(--border-subtle)' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
              <Mail size={15} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{user?.email}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
              <Shield size={15} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-primary)', textTransform: 'uppercase', fontWeight: 600, fontSize: '11px', letterSpacing: '0.05em' }}>
                {user?.role || 'Viewer'}
              </span>
            </div>
            {githubLinked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
                <ShieldCheck size={15} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>GitHub Linked</span>
              </div>
            )}
          </div>

          {githubLinked && (
            <>
              <div style={{ width: '100%', height: '1px', background: 'var(--border-subtle)' }} />
              <button
                type="button"
                onClick={handleUnlink}
                style={{
                  width: '100%', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)',
                  padding: '8px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.1)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.06)'}
              >
                <LogOut size={13} /> Unlink GitHub
              </button>
            </>
          )}
        </div>

        {/* Right Column ── GitHub Developer View */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Case A: GitHub NOT linked */}
          {!githubLinked ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', padding: '48px 24px', textAlign: 'center' }}>
              <div style={{
                width: '72px', height: '72px', borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-subtle)',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <img
                  src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"
                  alt="GitHub"
                  style={{ width: '36px', height: '36px', filter: 'invert(1)' }}
                />
              </div>
              <div>
                <h3 style={{ fontSize: '16px', margin: '0 0 6px', color: 'var(--text-primary)' }}>GitHub Integration Inactive</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '460px', margin: '0 auto', lineHeight: '1.5' }}>
                  Connect your GitHub developer profile to view your stats, followers, public repository graphs, contribution calendars, and easily deploy pipelines.
                </p>
              </div>
              <button
                type="button"
                onClick={handleConnectGithub}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: '#24292f', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 'var(--radius-md)', color: '#fff',
                  padding: '10px 24px', fontWeight: 600, fontSize: '13.5px', cursor: 'pointer',
                  transition: 'opacity 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                onMouseLeave={e => e.currentTarget.style.opacity = '1'}
              >
                <img
                  src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"
                  alt="GitHub"
                  style={{ width: '16px', height: '16px', filter: 'invert(1)' }}
                />
                Connect GitHub Profile
              </button>
            </div>
          ) : (
            /* Case B: GitHub IS linked */
            <>
              {/* GitHub Developer Profile Details */}
              {ghProfile && (
                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                    <img
                      src={ghProfile.avatar_url}
                      alt={ghProfile.login}
                      style={{
                        width: '64px', height: '64px', borderRadius: '50%',
                        border: '2px solid var(--border-active)'
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <h2 style={{ fontSize: '18px', margin: '0', color: 'var(--text-primary)' }}>
                          {ghProfile.name || ghProfile.login}
                        </h2>
                        <a href={ghProfile.html_url} target="_blank" rel="noopener noreferrer" style={{
                          fontSize: '11px', background: 'rgba(255,255,255,0.06)',
                          border: '1px solid var(--border-subtle)', borderRadius: '10px',
                          padding: '2px 8px', color: 'var(--text-muted)', textDecoration: 'none',
                          fontWeight: 500
                        }}>
                          @{ghProfile.login}
                        </a>
                      </div>
                      {ghProfile.bio && (
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                          {ghProfile.bio}
                        </p>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '12.5px', color: 'var(--text-muted)' }}>
                    {ghProfile.company && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Briefcase size={14} /> {ghProfile.company}
                      </span>
                    )}
                    {ghProfile.location && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <MapPin size={14} /> {ghProfile.location}
                      </span>
                    )}
                    {ghProfile.blog && (
                      <a href={ghProfile.blog.startsWith('http') ? ghProfile.blog : `https://${ghProfile.blog}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--accent-cyan)', textDecoration: 'none' }}>
                        <Link2 size={14} /> Website
                      </a>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '16px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Users size={16} style={{ color: 'var(--accent-blue)' }} />
                      <div style={{ fontSize: '12px' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{ghProfile.followers}</strong> followers
                      </div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Users size={16} style={{ color: 'var(--accent-purple)' }} />
                      <div style={{ fontSize: '12px' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{ghProfile.following}</strong> following
                      </div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <BookOpen size={16} style={{ color: 'var(--accent-cyan)' }} />
                      <div style={{ fontSize: '12px' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{ghProfile.public_repos}</strong> repositories
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* GitHub Contribution Calendar Matrix (Green squares) */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <h3 style={{ fontSize: '14px', margin: '0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <RefreshCw size={14} style={{ color: 'var(--accent-cyan)' }} /> GitHub Contribution Activity
                </h3>
                {ghProfile && (
                  <div style={{
                    width: '100%', overflowX: 'auto', background: 'rgba(0,0,0,0.2)',
                    border: '1px solid rgba(255,255,255,0.06)', borderRadius: 'var(--radius-sm)',
                    padding: '16px', display: 'flex', justifyContent: 'center'
                  }}>
                    <img
                      src={`https://ghchart.rshah.org/06b6d4/${ghProfile.login}`}
                      alt={`${ghProfile.login}'s GitHub contributions chart`}
                      style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
                    />
                  </div>
                )}
              </div>

              {/* Repository Browser with branch listing */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h3 style={{ fontSize: '14px', margin: '0', color: 'var(--text-primary)' }}>Repository Manager</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {ghRepos.length === 0 ? (
                    <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '12.5px', textAlign: 'center' }}>
                      No public repositories found.
                    </div>
                  ) : (
                    ghRepos.map(repo => {
                      const isExpanded = expandedRepo === repo.fullName;
                      return (
                        <div
                          key={repo.fullName}
                          style={{
                            background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-subtle)',
                            borderRadius: 'var(--radius-sm)', padding: '12px', display: 'flex',
                            flexDirection: 'column', gap: '10px'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <a href={repo.url} target="_blank" rel="noopener noreferrer" style={{
                                  fontWeight: 700, fontSize: '13.5px', color: 'var(--text-primary)',
                                  textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px'
                                }}>
                                  {repo.name} <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                                </a>
                                {repo.private && <span style={{ fontSize: '9px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '1px 5px', color: 'var(--text-muted)' }}>Private</span>}
                              </div>
                              {repo.description && (
                                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: '1.4' }}>
                                  {repo.description}
                                </p>
                              )}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                              {repo.language && (
                                <span style={{ fontSize: '10.5px', color: 'var(--accent-purple)', background: 'rgba(168,85,247,0.1)', padding: '2px 8px', borderRadius: '10px', fontWeight: 600 }}>
                                  {repo.language}
                                </span>
                              )}
                              {repo.stars > 0 && (
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                                  <Star size={12} /> {repo.stars}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => toggleRepoBranches(repo.fullName)}
                                style={{
                                  background: isExpanded ? 'var(--accent-cyan)' : 'rgba(255,255,255,0.04)',
                                  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                                  color: isExpanded ? '#000' : 'var(--text-primary)',
                                  padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                                  transition: 'all 0.15s'
                                }}
                              >
                                <GitBranch size={11} /> Branches
                              </button>
                            </div>
                          </div>

                          {/* Branches expansion block */}
                          {isExpanded && (
                            <div style={{
                              borderTop: '1px solid var(--border-subtle)', paddingTop: '10px',
                              display: 'flex', flexDirection: 'column', gap: '8px'
                            }}>
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Available Branches:</div>
                              {branchesLoading[repo.fullName] ? (
                                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>Loading repo branches...</div>
                              ) : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {(branches[repo.fullName] || []).map(b => (
                                    <a
                                      key={b.name}
                                      href={`https://github.com/${repo.fullName}/tree/${b.name}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        fontSize: '11px', background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid var(--border-subtle)', borderRadius: '4px',
                                        padding: '4px 10px', color: 'var(--text-primary)', textDecoration: 'none',
                                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                                        transition: 'background 0.2s'
                                      }}
                                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                                    >
                                      <GitBranch size={9} /> {b.name}
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

export default Profile;
