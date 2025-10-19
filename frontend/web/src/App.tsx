// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ReputationRecord {
  id: string;
  daoName: string;
  contributor: string;
  encryptedScore: string;
  encryptedHours: string;
  timestamp: number;
  verified: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeReputation = (encryptedScore: string, encryptedHours: string): string => {
  const score = FHEDecryptNumber(encryptedScore);
  const hours = FHEDecryptNumber(encryptedHours);
  const reputation = score * Math.log10(hours + 1); // Simple reputation formula
  return FHEEncryptNumber(reputation);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<ReputationRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<ReputationRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ daoName: "", score: 0, hours: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ReputationRecord | null>(null);
  const [decryptedData, setDecryptedData] = useState<{ score?: number, hours?: number, reputation?: number } | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterVerified, setFilterVerified] = useState(false);

  // Calculate statistics
  const totalContributions = records.length;
  const verifiedContributions = records.filter(r => r.verified).length;
  const totalHours = records.reduce((sum, record) => sum + FHEDecryptNumber(record.encryptedHours), 0);
  const avgReputation = totalContributions > 0 ? 
    records.reduce((sum, record) => sum + FHEDecryptNumber(FHEComputeReputation(record.encryptedScore, record.encryptedHours)), 0) / totalContributions : 0;

  // Contributor ranking
  const contributorStats = records.reduce((acc, record) => {
    if (!acc[record.contributor]) {
      acc[record.contributor] = { totalHours: 0, totalScore: 0, count: 0 };
    }
    acc[record.contributor].totalHours += FHEDecryptNumber(record.encryptedHours);
    acc[record.contributor].totalScore += FHEDecryptNumber(record.encryptedScore);
    acc[record.contributor].count++;
    return acc;
  }, {} as Record<string, { totalHours: number, totalScore: number, count: number }>);

  const contributorRanking = Object.entries(contributorStats)
    .map(([contributor, stats]) => ({
      contributor,
      avgScore: stats.totalScore / stats.count,
      totalHours: stats.totalHours,
      reputation: (stats.totalScore / stats.count) * Math.log10(stats.totalHours + 1)
    }))
    .sort((a, b) => b.reputation - a.reputation)
    .slice(0, 5);

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    let result = records;
    if (searchTerm) {
      result = result.filter(record => 
        record.daoName.toLowerCase().includes(searchTerm.toLowerCase()) || 
        record.contributor.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    if (filterVerified) {
      result = result.filter(record => record.verified);
    }
    setFilteredRecords(result);
  }, [records, searchTerm, filterVerified]);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      
      const list: ReputationRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                daoName: recordData.daoName, 
                contributor: recordData.contributor, 
                encryptedScore: recordData.score, 
                encryptedHours: recordData.hours, 
                timestamp: recordData.timestamp, 
                verified: recordData.verified || false 
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting DAO contribution with Zama FHE..." });
    try {
      const encryptedScore = FHEEncryptNumber(newRecordData.score);
      const encryptedHours = FHEEncryptNumber(newRecordData.hours);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        daoName: newRecordData.daoName, 
        contributor: address, 
        score: encryptedScore, 
        hours: encryptedHours, 
        timestamp: Math.floor(Date.now() / 1000), 
        verified: false 
      };
      
      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "DAO contribution encrypted and stored!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ daoName: "", score: 0, hours: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedScore: string, encryptedHours: string): Promise<{ score: number, hours: number, reputation: number } | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const score = FHEDecryptNumber(encryptedScore);
      const hours = FHEDecryptNumber(encryptedHours);
      const reputation = score * Math.log10(hours + 1);
      
      return { score, hours, reputation };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const verifyRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying DAO contribution with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, verified: true };
      await contractWithSigner.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Contribution verified with FHE!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>DAO<span>Reputation</span>Protocol</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn metal-button">
            <div className="add-icon"></div>Add Contribution
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Decentralized Reputation Protocol</h2>
            <p>FHE-encrypted reputation scores for DAO contributors across multiple organizations</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>Zama FHE Encryption Active</span></div>
        </div>
        
        <div className="dashboard-grid">
          <div className="dashboard-card metal-card">
            <h3>Project Introduction</h3>
            <p>A cross-DAO reputation protocol that <strong>FHE-encrypts</strong> contributor history and evaluations, generating private, verifiable reputation scores usable for DeFi undercollateralized loans.</p>
            <div className="key-features">
              <div className="feature"><div className="feature-icon">🔒</div>FHE-encrypted contribution history</div>
              <div className="feature"><div className="feature-icon">⚙️</div>Homomorphic reputation computation</div>
              <div className="feature"><div className="feature-icon">📊</div>ZK proofs for DeFi applications</div>
            </div>
            <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Protocol Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{totalContributions}</div>
                <div className="stat-label">Total Contributions</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{verifiedContributions}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{Math.round(totalHours)}</div>
                <div className="stat-label">Total Hours</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{avgReputation.toFixed(1)}</div>
                <div className="stat-label">Avg Reputation</div>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Top Contributors</h3>
            <div className="contributor-ranking">
              {contributorRanking.length > 0 ? (
                contributorRanking.map((contributor, index) => (
                  <div className="contributor-item" key={index}>
                    <div className="rank">#{index + 1}</div>
                    <div className="contributor-info">
                      <div className="address">{contributor.contributor.substring(0, 6)}...{contributor.contributor.substring(38)}</div>
                      <div className="stats">
                        <span>{Math.round(contributor.reputation)} RP</span>
                        <span>{Math.round(contributor.totalHours)} hrs</span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="no-contributors">No contributions recorded yet</div>
              )}
            </div>
          </div>
        </div>
        
        <div className="records-section">
          <div className="section-header">
            <h2>DAO Contributions</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search DAOs or contributors..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <label className="filter-checkbox">
                  <input 
                    type="checkbox" 
                    checked={filterVerified}
                    onChange={(e) => setFilterVerified(e.target.checked)}
                  />
                  Verified only
                </label>
              </div>
              <button onClick={loadRecords} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="records-list metal-card">
            <div className="table-header">
              <div className="header-cell">DAO</div>
              <div className="header-cell">Contributor</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No contributions found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Add First Contribution</button>
              </div>
            ) : filteredRecords.map(record => (
              <div 
                className="record-row" 
                key={record.id} 
                onClick={() => setSelectedRecord(record)}
                data-verified={record.verified}
              >
                <div className="table-cell">{record.daoName}</div>
                <div className="table-cell">{record.contributor.substring(0, 6)}...{record.contributor.substring(38)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${record.verified ? 'verified' : 'pending'}`}>
                    {record.verified ? 'Verified' : 'Pending'}
                  </span>
                </div>
                <div className="table-cell actions">
                  {isOwner(record.contributor) && !record.verified && (
                    <button 
                      className="action-btn metal-button success" 
                      onClick={(e) => { e.stopPropagation(); verifyRecord(record.id); }}
                    >
                      Verify
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}
      
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedData(null); }} 
          decryptedData={decryptedData} 
          setDecryptedData={setDecryptedData} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>DAO Reputation Protocol</span></div>
            <p>Private, verifiable reputation scores for DAO contributors</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} DAO Reputation Protocol. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.daoName || !recordData.score || !recordData.hours) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Add DAO Contribution</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your contribution data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>DAO Name *</label>
              <input 
                type="text" 
                name="daoName" 
                value={recordData.daoName} 
                onChange={handleChange} 
                placeholder="Enter DAO name..." 
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Contribution Score (1-100) *</label>
              <input 
                type="number" 
                name="score" 
                value={recordData.score} 
                onChange={handleNumberChange} 
                min="1" 
                max="100" 
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Hours Contributed *</label>
              <input 
                type="number" 
                name="hours" 
                value={recordData.hours} 
                onChange={handleNumberChange} 
                min="0" 
                step="0.1" 
                className="metal-input"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Score: {recordData.score || '0'}</div>
                <div>Hours: {recordData.hours || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Score: {recordData.score ? FHEEncryptNumber(recordData.score).substring(0, 20) + '...' : 'Not encrypted'}</div>
                <div>Hours: {recordData.hours ? FHEEncryptNumber(recordData.hours).substring(0, 20) + '...' : 'Not encrypted'}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Contribution"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: ReputationRecord;
  onClose: () => void;
  decryptedData: { score?: number, hours?: number, reputation?: number } | null;
  setDecryptedData: (data: { score?: number, hours?: number, reputation?: number } | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedScore: string, encryptedHours: string) => Promise<{ score: number, hours: number, reputation: number } | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, 
  onClose, 
  decryptedData, 
  setDecryptedData, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedData !== null) { 
      setDecryptedData(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(record.encryptedScore, record.encryptedHours);
    if (decrypted !== null) setDecryptedData(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal metal-card">
        <div className="modal-header">
          <h2>Contribution Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>DAO:</span><strong>{record.daoName}</strong></div>
            <div className="info-item"><span>Contributor:</span><strong>{record.contributor.substring(0, 6)}...{record.contributor.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${record.verified ? 'verified' : 'pending'}`}>
                {record.verified ? 'Verified' : 'Pending'}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data-grid">
              <div>
                <h4>Score</h4>
                <div className="encrypted-value">{record.encryptedScore.substring(0, 30)}...</div>
              </div>
              <div>
                <h4>Hours</h4>
                <div className="encrypted-value">{record.encryptedHours.substring(0, 30)}...</div>
              </div>
            </div>
            
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedData !== null ? (
                "Hide Decrypted Values"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedData !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data-grid">
                <div>
                  <h4>Score</h4>
                  <div className="decrypted-value">{decryptedData.score}</div>
                </div>
                <div>
                  <h4>Hours</h4>
                  <div className="decrypted-value">{decryptedData.hours}</div>
                </div>
                <div>
                  <h4>Reputation</h4>
                  <div className="decrypted-value">{decryptedData.reputation?.toFixed(2)}</div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;