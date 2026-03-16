export default function ApprovalDialog({ question, resolved, onApprove, onReject }) {
  return (
    <div className="approval-box">
      <div className="title">Approval Required</div>
      <div className="question">{question}</div>
      <div className="actions">
        {resolved ? (
          <span className={resolved === "approved" ? "approved-text" : "rejected-text"}>
            {resolved === "approved" ? "Approved" : "Rejected"}
          </span>
        ) : (
          <>
            <button className="approve-btn" onClick={onApprove}>
              Approve
            </button>
            <button className="reject-btn" onClick={onReject}>
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
