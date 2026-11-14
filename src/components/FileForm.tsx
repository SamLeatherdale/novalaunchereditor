import React, { ChangeEventHandler } from "react";

interface FileFormProps {
  id?: string;
  label?: string;
  variant?: "primary" | "secondary";
  onChange: ChangeEventHandler<HTMLInputElement>;
}

const FileForm: React.FC<FileFormProps> = ({
  id = "inputFile",
  label = "Open Primary Backup",
  variant = "primary",
  onChange,
}) => (
  <label
    htmlFor={id}
    className={`btn ${variant === "primary" ? "btn-primary" : "btn-outline-secondary"} mb-0 file-upload-btn`}
  >
    <i className={`fas ${variant === "primary" ? "fa-folder-open" : "fa-layer-group"} me-2`} />
    {label}
    <input type="file" id={id} accept=".novabackup,.zip,.exml,.xml" onChange={onChange} hidden />
  </label>
);

export default FileForm;
