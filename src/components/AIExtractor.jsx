import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, UploadCloud } from 'lucide-react';
import { supabase } from '../supabaseClient';

const ACCEPTED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export default function AIExtractor({ onExtractedData }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    localStorage.removeItem('billing_mvp_gemini_key');
  }, []);

  const processFile = async file => {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setError('Please upload a valid PDF or JPG file.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('The file is too large. Upload a PDF or JPG under 10 MB.');
      return;
    }

    setError('');
    setIsLoading(true);
    try {
      const base64Data = await readFileAsBase64(file);
      const { data, error: functionError } = await supabase.functions.invoke(
        'extract-purchase-order',
        {
          body: {
            mimeType: file.type === 'application/pdf' ? 'application/pdf' : 'image/jpeg',
            data: base64Data,
          },
        }
      );
      if (functionError) {
        const response = functionError.context;
        const responseBody = response instanceof Response
          ? await response.json().catch(() => null)
          : null;
        throw new Error(
          responseBody?.error ||
          functionError.message ||
          'Purchase order extraction failed.'
        );
      }
      if (!data?.extractedData || typeof data.extractedData !== 'object') {
        throw new Error('The extraction service returned an invalid response.');
      }
      onExtractedData(data.extractedData);
    } catch (extractError) {
      setError(extractError.message || 'Could not extract purchase order details.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = event => {
    event.preventDefault();
    setIsDragging(false);
    processFile(event.dataTransfer.files[0]);
  };

  const handleFileChange = event => {
    processFile(event.target.files[0]);
    event.target.value = '';
  };

  const readFileAsBase64 = file =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Could not read the selected file.'));
          return;
        }
        resolve(result.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });

  return (
    <div>
      <div
        className={`dropzone${isDragging ? ' drag-over' : ''}`}
        onDragOver={event => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={event => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={handleDrop}
        onClick={() => !isLoading && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={event => {
          if (!isLoading && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        aria-disabled={isLoading}
      >
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/jpg"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
          disabled={isLoading}
        />

        {isLoading ? (
          <>
            <div className="dropzone-icon"><Loader2 size={20} className="spin" /></div>
            <h4>Extracting data from PO…</h4>
            <p>AI is reading your purchase order</p>
          </>
        ) : (
          <>
            <div className="dropzone-icon"><UploadCloud size={20} /></div>
            <h4>Drop Purchase Order PDF or JPG here</h4>
            <p>or click to browse — AI will auto-fill the form</p>
          </>
        )}
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: '10px' }} role="alert">
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
