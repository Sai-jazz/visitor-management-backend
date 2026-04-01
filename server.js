const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

console.log('🔌 Supabase initialized');

// =====================================================
// VISITOR REGISTRATION
// =====================================================

app.post('/api/visitors/register', async (req, res) => {
    console.log('📝 Visitor registration received:', req.body);
    
    try {
        const { name, phone, flat, purpose, vehicle, selfie } = req.body;
        
        if (!name || !phone || !flat || !purpose) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Find or create visitor
        let visitorId;
        
        const { data: existingVisitor } = await supabase
            .from('visitors')
            .select('*')
            .eq('phone', phone)
            .single();
        
        if (!existingVisitor) {
            const { data: newVisitor, error: insertError } = await supabase
                .from('visitors')
                .insert({
                    name,
                    phone,
                    total_visits: 1,
                    first_visit: new Date(),
                    last_visit: new Date()
                })
                .select()
                .single();
            
            if (insertError) throw insertError;
            visitorId = newVisitor.id;
            console.log('👤 Created new visitor:', name);
        } else {
            visitorId = existingVisitor.id;
            await supabase
                .from('visitors')
                .update({
                    total_visits: existingVisitor.total_visits + 1,
                    last_visit: new Date()
                })
                .eq('id', visitorId);
            console.log('👤 Existing visitor:', name);
        }
        
        // Save selfie if provided
        let photoUrl = null;
        if (selfie && selfie.startsWith('data:image')) {
            photoUrl = selfie;
        }
        
        // Get resident details
        const { data: resident } = await supabase
            .from('residents')
            .select('id')
            .eq('flat_number', flat)
            .single();
        
        // Create pending approval with status = 'pending'
        const { data: approval, error: approvalError } = await supabase
            .from('pending_approvals')
            .insert({
                visitor_id: visitorId,
                visitor_name: name,
                visitor_phone: phone,
                visitor_photo_url: photoUrl,
                visiting_flat: flat,
                purpose: purpose,
                vehicle_number: vehicle || null,
                resident_id: resident ? resident.id : null,
                status: 'pending',
                timestamp: new Date(),
                expires_at: new Date(Date.now() + 15 * 60 * 1000)
            })
            .select()
            .single();
        
        if (approvalError) throw approvalError;
        
        console.log('✅ Approval created with ID:', approval.id, 'Status:', approval.status);
        
        res.json({
            success: true,
            approvalId: approval.id,
            message: 'Registration complete. Please wait for security approval.'
        });
        
    } catch (error) {
        console.error('❌ Visitor Registration Error:', error);
        res.status(500).json({ error: 'Registration failed: ' + error.message });
    }
});

// =====================================================
// GET PENDING APPROVALS
// =====================================================

app.get('/api/pending-approvals', async (req, res) => {
    try {
        console.log('📋 Fetching pending approvals...');
        
        const { data: approvals, error } = await supabase
            .from('pending_approvals')
            .select('*')
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString())
            .order('timestamp', { ascending: false });
        
        if (error) throw error;
        
        console.log(`✅ Found ${approvals?.length || 0} pending approvals`);
        res.json({ success: true, approvals: approvals || [] });
        
    } catch (error) {
        console.error('❌ Error fetching approvals:', error);
        res.status(500).json({ error: 'Failed to fetch approvals' });
    }
});

// =====================================================
// PROCESS APPROVAL (APPROVE OR DENY) - FIXED
// =====================================================

app.post('/api/approvals/:approvalId/process', async (req, res) => {
    try {
        const { approvalId } = req.params;
        const { action, guardId, notes } = req.body;
        
        console.log(`📋 Processing approval ${approvalId}: ${action}`);
        
        if (!['approve', 'deny'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }
        
        // Get the approval
        const { data: approval, error: fetchError } = await supabase
            .from('pending_approvals')
            .select('*')
            .eq('id', approvalId)
            .single();
        
        if (fetchError || !approval) {
            console.error('❌ Approval not found');
            return res.status(404).json({ error: 'Approval not found' });
        }
        
        console.log(`Current status: ${approval.status}`);
        
        if (approval.status !== 'pending') {
            return res.status(400).json({ error: `Already ${approval.status}` });
        }
        
        if (action === 'approve') {
            // Create entry log
            await supabase
                .from('entry_logs')
                .insert({
                    entry_type: 'visitor',
                    visitor_id: approval.visitor_id,
                    visitor_name: approval.visitor_name,
                    visitor_phone: approval.visitor_phone,
                    visitor_photo_url: approval.visitor_photo_url,
                    visiting_flat: approval.visiting_flat,
                    purpose: approval.purpose,
                    vehicle_number: approval.vehicle_number,
                    approval_status: 'approved',
                    approved_by: guardId,
                    timestamp: new Date()
                });
            
            // Update approval status - only update columns that exist
            const updateData = { 
                status: 'approved'
            };
            
            // Only add these if they exist (checking in database)
            try {
                updateData.approved_by = guardId;
                updateData.approved_at = new Date();
            } catch (e) {
                console.log('Columns may not exist, skipping...');
            }
            
            const { error: updateError } = await supabase
                .from('pending_approvals')
                .update(updateData)
                .eq('id', approvalId);
            
            if (updateError) {
                console.error('Update error:', updateError);
                // Try without the extra columns
                const { error: retryError } = await supabase
                    .from('pending_approvals')
                    .update({ status: 'approved' })
                    .eq('id', approvalId);
                
                if (retryError) throw retryError;
            }
            
            console.log(`✅ ${approval.visitor_name} approved`);
            res.json({ success: true, message: 'Entry approved' });
            
        } else {
            // Deny - update status to denied
            const updateData = { 
                status: 'denied'
            };
            
            try {
                updateData.approved_by = guardId;
                updateData.denied_at = new Date();
                updateData.denied_reason = notes || 'Denied by security';
            } catch (e) {
                console.log('Columns may not exist, skipping...');
            }
            
            const { error: updateError } = await supabase
                .from('pending_approvals')
                .update(updateData)
                .eq('id', approvalId);
            
            if (updateError) {
                // Try without the extra columns
                const { error: retryError } = await supabase
                    .from('pending_approvals')
                    .update({ status: 'denied' })
                    .eq('id', approvalId);
                
                if (retryError) throw retryError;
            }
            
            console.log(`❌ ${approval.visitor_name} denied`);
            res.json({ success: true, message: 'Entry denied' });
        }
        
    } catch (error) {
        console.error('❌ Approval Error:', error);
        res.status(500).json({ error: 'Failed to process approval' });
    }
});

// =====================================================
// EXIT LOGGING
// =====================================================

app.post('/api/exit', async (req, res) => {
    try {
        const { entryLogId, guardId } = req.body;
        
        const { error } = await supabase
            .from('entry_logs')
            .update({
                exit_time: new Date(),
                approved_by: guardId
            })
            .eq('id', entryLogId);
        
        if (error) throw error;
        
        res.json({ success: true, message: 'Exit logged' });
        
    } catch (error) {
        console.error('❌ Exit Error:', error);
        res.status(500).json({ error: 'Failed to log exit' });
    }
});

// =====================================================
// RESIDENT QR VERIFICATION
// =====================================================

app.post('/api/residents/verify', async (req, res) => {
    try {
        const { qrData, guardId } = req.body;
        
        const parts = qrData.split(':');
        if (parts[0] !== 'RES') {
            return res.status(400).json({ error: 'Invalid QR code format' });
        }
        
        const residentId = parts[1];
        
        const { data: resident, error } = await supabase
            .from('residents')
            .select('*')
            .eq('id', residentId)
            .eq('is_active', true)
            .single();
        
        if (error || !resident) {
            return res.status(404).json({ error: 'Resident not found' });
        }
        
        await supabase
            .from('entry_logs')
            .insert({
                entry_type: 'resident',
                resident_id: resident.id,
                resident_name: resident.name,
                visiting_flat: resident.flat_number,
                approval_status: 'approved',
                approved_by: guardId,
                timestamp: new Date()
            });
        
        res.json({
            success: true,
            resident: {
                id: resident.id,
                name: resident.name,
                flat_number: resident.flat_number,
                phone: resident.phone
            }
        });
        
    } catch (error) {
        console.error('❌ QR Verification Error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// =====================================================
// GET ENTRY LOGS
// =====================================================

app.get('/api/entry-logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        
        const { data: logs, error } = await supabase
            .from('entry_logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(limit);
        
        if (error) throw error;
        
        res.json({ success: true, logs: logs || [] });
        
    } catch (error) {
        console.error('❌ Entry Logs Error:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// =====================================================
// GET STATS
// =====================================================

app.get('/api/stats', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const { count: todayCount } = await supabase
            .from('entry_logs')
            .select('*', { count: 'exact', head: true })
            .gte('timestamp', today.toISOString());
        
        const { count: pendingCount } = await supabase
            .from('pending_approvals')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString());
        
        const { data: activeEntries } = await supabase
            .from('entry_logs')
            .select('*')
            .is('exit_time', null);
        
        res.json({
            success: true,
            stats: {
                activeInside: activeEntries?.length || 0,
                todayEntries: todayCount || 0,
                pendingApprovals: pendingCount || 0
            }
        });
        
    } catch (error) {
        console.error('❌ Stats Error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// =====================================================
// DEBUG ENDPOINT
// =====================================================

app.get('/api/debug/all-approvals', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pending_approvals')
            .select('*')
            .order('timestamp', { ascending: false });
        
        if (error) throw error;
        
        const pending = data?.filter(a => a.status === 'pending') || [];
        const approved = data?.filter(a => a.status === 'approved') || [];
        const denied = data?.filter(a => a.status === 'denied') || [];
        
        res.json({
            success: true,
            total: data?.length || 0,
            counts: { pending: pending.length, approved: approved.length, denied: denied.length },
            approvals: data
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Supabase connected`);
});