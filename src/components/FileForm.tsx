import React, { Component, ChangeEventHandler } from 'react';

class FileForm extends Component<{
	onChange: ChangeEventHandler
}, {}> {
	render() {
	return (
		<form>
			<div className="input-group">
				<div className="custom-file">
					<input type="file" className="custom-form-input" 
						id="inputFile" accept=".novabackup" onChange={this.props.onChange} />
					<label className="custom-file-label" htmlFor="inputFile">
						Select .novabackup file</label>
				</div>
			</div>
		</form>
	);
	}
}

export default FileForm;