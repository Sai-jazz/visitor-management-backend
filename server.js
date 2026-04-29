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
// AUTH MIDDLEWARE - Verify JWT Token
// =====================================================

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        
        req.user = user;
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        return res.status(401).json({ error: 'Authentication failed' });
    }
};

// =====================================================
// ADMIN PROFILE ENDPOINT (Required for React Admin Dashboard)
// =====================================================

app.get('/api/admin/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log('🔍 Fetching admin profile for user:', userId);
        
        const { data: admin, error } = await supabase
            .from('apartment_admins')
            .select('*, apartments(*)')
            .eq('auth_user_id', userId)
            .single();
        
        if (error || !admin) {
            console.log('❌ No admin found for user:', userId);
            return res.status(403).json({ success: false, error: 'Not authorized as admin' });
        }
        
        console.log('✅ Admin found:', admin.name);
        
        res.json({
            success: true,
            admin: { id: admin.id, name: admin.name, email: admin.email },
            apartment: admin.apartments
        });
        
    } catch (error) {
        console.error('Admin profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// APARTMENT ENDPOINTS
// =====================================================

// Get all apartments
app.get('/api/apartments', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('apartments')
            .select('*')
            .order('name');
        
        if (error) throw error;
        res.json({ success: true, apartments: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get apartment by ID
app.get('/api/apartments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('apartments')
            .select('*')
            .eq('id', id)
            .single();
        
        if (error) throw error;
        res.json({ success: true, apartment: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create apartment
app.post('/api/apartments', async (req, res) => {
    try {
        const { name, address } = req.body;
        
        const { data, error } = await supabase
            .from('apartments')
            .insert({ name, address })
            .select()
            .single();
        
        if (error) throw error;
        res.json({ success: true, apartment: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// GUARD LOGIN & AUTHENTICATION
// =====================================================

// Guard login
app.post('/api/guard/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Authenticate with Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        
        if (authError) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Get guard details with apartment
        const { data: guard, error: guardError } = await supabase
            .from('apartment_guards')
            .select(`
                *,
                apartments:apartment_id (
                    id,
                    name,
                    address
                )
            `)
            .eq('auth_user_id', authData.user.id)
            .single();
        
        if (guardError || !guard) {
            return res.status(403).json({ error: 'Not authorized as guard' });
        }
        
        if (!guard.is_active) {
            return res.status(403).json({ error: 'Your account is inactive' });
        }
        
        // Update last login
        await supabase
            .from('apartment_guards')
            .update({ last_login: new Date() })
            .eq('id', guard.id);
        
        res.json({
            success: true,
            guard: {
                id: guard.id,
                name: guard.name,
                email: guard.email,
                phone: guard.phone,
                shift: guard.shift,
                apartment: guard.apartments
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// =====================================================
// RESIDENT MANAGEMENT (Per Apartment)
// =====================================================

// Get all residents for an apartment
app.get('/api/apartments/:apartmentId/residents', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data, error } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('is_active', true)
            .order('flat_number');
        
        if (error) throw error;
        res.json({ success: true, residents: data || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create resident with auto QR generation
app.post('/api/apartments/:apartmentId/residents', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { flat_number, name, phone, email, vehicle_number } = req.body;
        
        if (!flat_number || !name || !phone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Insert resident
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .insert({
                apartment_id: apartmentId,
                flat_number,
                name,
                phone,
                email,
                vehicle_number
            })
            .select()
            .single();
        
        if (error) throw error;
        
        // Generate QR code
        const qrData = `RES:${resident.id}:${resident.flat_number}`;
        const qrBuffer = await QRCode.toBuffer(qrData, {
            width: 500,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        
        const qrBase64 = qrBuffer.toString('base64');
        const qrImageUrl = `data:image/png;base64,${qrBase64}`;
        
        // Update resident with QR code
        await supabase
            .from('apartment_residents')
            .update({
                qr_code_value: qrData,
                qr_code_url: qrImageUrl
            })
            .eq('id', resident.id);
        
        res.json({
            success: true,
            resident: {
                ...resident,
                qr_code_url: qrImageUrl
            }
        });
        
    } catch (error) {
        console.error('Create resident error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete resident
app.delete('/api/apartments/:apartmentId/residents/:residentId', async (req, res) => {
    try {
        const { residentId } = req.params;
        
        const { error } = await supabase
            .from('apartment_residents')
            .update({ is_active: false })
            .eq('id', residentId);
        
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// VISITOR REGISTRATION (Per Apartment)
// =====================================================

app.post('/api/apartments/:apartmentId/visitors/register', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { name, phone, flat, purpose, vehicle, selfie } = req.body;
        
        if (!name || !phone || !flat || !purpose) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Find or create visitor in apartment_visitors
        let visitorId;
        const { data: existingVisitor } = await supabase
            .from('apartment_visitors')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('phone', phone)
            .single();
        
        if (!existingVisitor) {
            const { data: newVisitor, error: insertError } = await supabase
                .from('apartment_visitors')
                .insert({
                    apartment_id: apartmentId,
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
        } else {
            visitorId = existingVisitor.id;
            await supabase
                .from('apartment_visitors')
                .update({
                    total_visits: existingVisitor.total_visits + 1,
                    last_visit: new Date()
                })
                .eq('id', visitorId);
        }
        
        // Get resident for this flat
        const { data: resident } = await supabase
            .from('apartment_residents')
            .select('id')
            .eq('apartment_id', apartmentId)
            .eq('flat_number', flat)
            .single();
        
        // Create pending approval
        const { data: approval, error: approvalError } = await supabase
            .from('apartment_pending_approvals')
            .insert({
                apartment_id: apartmentId,
                visitor_id: visitorId,
                visitor_name: name,
                visitor_phone: phone,
                visitor_photo_url: selfie || null,
                visiting_flat: flat,
                purpose: purpose,
                vehicle_number: vehicle || null,
                resident_id: resident?.id || null,
                expires_at: new Date(Date.now() + 15 * 60 * 1000)
            })
            .select()
            .single();
        
        if (approvalError) throw approvalError;
        
        res.json({
            success: true,
            approvalId: approval.id,
            message: 'Registration complete. Please wait for security approval.'
        });
        
    } catch (error) {
        console.error('Visitor registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// =====================================================
// PENDING APPROVALS (Per Apartment)
// =====================================================

app.get('/api/apartments/:apartmentId/pending-approvals', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data, error } = await supabase
            .from('apartment_pending_approvals')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json({ success: true, approvals: data || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Process approval
app.post('/api/apartments/:apartmentId/approvals/:approvalId/process', async (req, res) => {
    try {
        const { apartmentId, approvalId } = req.params;
        const { action, guardId, notes } = req.body;
        
        if (!['approve', 'deny'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }
        
        // Get approval
        const { data: approval, error: fetchError } = await supabase
            .from('apartment_pending_approvals')
            .select('*')
            .eq('id', approvalId)
            .eq('apartment_id', apartmentId)
            .single();
        
        if (fetchError || !approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }
        
        if (approval.status !== 'pending') {
            return res.status(400).json({ error: `Already ${approval.status}` });
        }
        
        if (action === 'approve') {
            // Create entry log
            await supabase
                .from('apartment_entry_logs')
                .insert({
                    apartment_id: apartmentId,
                    entry_type: 'visitor',
                    visitor_id: approval.visitor_id,
                    person_name: approval.visitor_name,
                    person_phone: approval.visitor_phone,
                    flat_number: approval.visiting_flat,
                    purpose: approval.purpose,
                    vehicle_number: approval.vehicle_number,
                    entry_method: 'visitor_form',
                    approved_by: guardId,
                    entry_time: new Date()
                });
            
            // Update approval
            await supabase
                .from('apartment_pending_approvals')
                .update({
                    status: 'approved',
                    approved_by: guardId,
                    processed_at: new Date()
                })
                .eq('id', approvalId);
            
            res.json({ success: true, message: 'Entry approved' });
        } else {
            await supabase
                .from('apartment_pending_approvals')
                .update({
                    status: 'denied',
                    approved_by: guardId,
                    denied_reason: notes || 'Denied by security',
                    processed_at: new Date()
                })
                .eq('id', approvalId);
            
            res.json({ success: true, message: 'Entry denied' });
        }
        
    } catch (error) {
        console.error('Approval error:', error);
        res.status(500).json({ error: 'Failed to process approval' });
    }
});

// =====================================================
// RESIDENT VERIFICATION (QR & Vehicle)
// =====================================================

// Verify resident by QR code
app.post('/api/apartments/:apartmentId/residents/verify-qr', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { qrData, guardId } = req.body;
        
        const parts = qrData.split(':');
        if (parts[0] !== 'RES') {
            return res.status(400).json({ error: 'Invalid QR code format' });
        }
        
        const residentId = parts[1];
        
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('id', residentId)
            .eq('apartment_id', apartmentId)
            .eq('is_active', true)
            .single();
        
        if (error || !resident) {
            return res.status(404).json({ error: 'Resident not found' });
        }
        
        // Check if already inside
        const { data: activeEntry } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('resident_id', resident.id)
            .is('exit_time', null)
            .single();
        
        if (activeEntry) {
            return res.status(400).json({ error: `${resident.name} is already inside!` });
        }
        
        // Create entry log
        await supabase
            .from('apartment_entry_logs')
            .insert({
                apartment_id: apartmentId,
                entry_type: 'resident',
                resident_id: resident.id,
                person_name: resident.name,
                person_phone: resident.phone,
                flat_number: resident.flat_number,
                vehicle_number: resident.vehicle_number,
                entry_method: 'qr',
                approved_by: guardId,
                entry_time: new Date()
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
        console.error('QR verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Verify resident by vehicle number
app.post('/api/apartments/:apartmentId/residents/verify-vehicle', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { vehicleNumber, guardId } = req.body;
        
        if (!vehicleNumber) {
            return res.status(400).json({ error: 'Vehicle number required' });
        }
        
        const normalizedVehicle = vehicleNumber.trim().toUpperCase().replace(/\s/g, '');
        
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('vehicle_number', normalizedVehicle)
            .eq('is_active', true)
            .single();
        
        if (error || !resident) {
            return res.status(404).json({ error: 'No resident found with this vehicle number' });
        }
        
        // Check if already inside
        const { data: activeEntry } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('resident_id', resident.id)
            .is('exit_time', null)
            .single();
        
        if (activeEntry) {
            return res.status(400).json({ error: `${resident.name} is already inside!` });
        }
        
        // Create entry log
        await supabase
            .from('apartment_entry_logs')
            .insert({
                apartment_id: apartmentId,
                entry_type: 'resident',
                resident_id: resident.id,
                person_name: resident.name,
                person_phone: resident.phone,
                flat_number: resident.flat_number,
                vehicle_number: normalizedVehicle,
                entry_method: 'vehicle',
                approved_by: guardId,
                entry_time: new Date()
            });
        
        res.json({
            success: true,
            resident: {
                id: resident.id,
                name: resident.name,
                flat_number: resident.flat_number,
                phone: resident.phone,
                vehicle_number: resident.vehicle_number
            }
        });
        
    } catch (error) {
        console.error('Vehicle verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// =====================================================
// ENTRY LOGS (Per Apartment)
// =====================================================

app.get('/api/apartments/:apartmentId/entry-logs', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const limit = parseInt(req.query.limit) || 100;
        
        const { data, error } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .order('entry_time', { ascending: false })
            .limit(limit);
        
        if (error) throw error;
        res.json({ success: true, logs: data || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mark exit
app.post('/api/apartments/:apartmentId/exit', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { entryLogId, guardId } = req.body;
        
        const { error } = await supabase
            .from('apartment_entry_logs')
            .update({
                exit_time: new Date(),
                approved_by: guardId
            })
            .eq('id', entryLogId)
            .eq('apartment_id', apartmentId);
        
        if (error) throw error;
        res.json({ success: true, message: 'Exit logged' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// STATS (Per Apartment)
// =====================================================

app.get('/api/apartments/:apartmentId/stats', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Active inside
        const { data: activeEntries } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .is('exit_time', null);
        
        // Today's entries
        const { count: todayCount } = await supabase
            .from('apartment_entry_logs')
            .select('*', { count: 'exact', head: true })
            .eq('apartment_id', apartmentId)
            .gte('entry_time', today.toISOString());
        
        // Pending approvals
        const { count: pendingCount } = await supabase
            .from('apartment_pending_approvals')
            .select('*', { count: 'exact', head: true })
            .eq('apartment_id', apartmentId)
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString());
        
        res.json({
            success: true,
            stats: {
                activeInside: activeEntries?.length || 0,
                todayEntries: todayCount || 0,
                pendingApprovals: pendingCount || 0
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// GENERATE QR CODE FOR RESIDENT
// =====================================================

app.post('/api/apartments/:apartmentId/residents/:residentId/generate-qr', async (req, res) => {
    try {
        const { apartmentId, residentId } = req.params;
        
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('id', residentId)
            .eq('apartment_id', apartmentId)
            .single();
        
        if (error || !resident) {
            return res.status(404).json({ error: 'Resident not found' });
        }
        
        const qrData = `RES:${resident.id}:${resident.flat_number}`;
        const qrBuffer = await QRCode.toBuffer(qrData, {
            width: 500,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        
        const qrBase64 = qrBuffer.toString('base64');
        const qrImageUrl = `data:image/png;base64,${qrBase64}`;
        
        await supabase
            .from('apartment_residents')
            .update({
                qr_code_value: qrData,
                qr_code_url: qrImageUrl
            })
            .eq('id', residentId);
        
        res.json({
            success: true,
            qr_code_url: qrImageUrl,
            qr_code_value: qrData
        });
        
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// =====================================================
// SECURE ADMIN APIs (No direct Supabase access from frontend)
// =====================================================

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Authenticate with Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email, password
        });
        
        if (authError) throw authError;
        
        // Get admin details
        const { data: admin, error: adminError } = await supabase
            .from('apartment_admins')
            .select('*, apartments(*)')
            .eq('auth_user_id', authData.user.id)
            .single();
        
        if (adminError || !admin) {
            return res.status(403).json({ success: false, error: 'Not authorized as admin' });
        }
        
        res.json({
            success: true,
            admin: { id: admin.id, name: admin.name, email: admin.email },
            apartment: admin.apartments
        });
        
    } catch (error) {
        res.status(401).json({ success: false, error: error.message });
    }
});

// Get dashboard stats
app.get('/api/admin/:apartmentId/stats', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { count: totalResidents } = await supabase
            .from('apartment_residents')
            .select('*', { count: 'exact', head: true })
            .eq('apartment_id', apartmentId)
            .eq('is_active', true);
        
        const { count: activeGuards } = await supabase
            .from('apartment_guards')
            .select('*', { count: 'exact', head: true })
            .eq('apartment_id', apartmentId)
            .eq('is_active', true);
        
        const { data: activeEntries } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .is('exit_time', null);
        
        const visitorsInside = activeEntries?.filter(e => e.entry_type === 'visitor').length || 0;
        const vehiclesInside = activeEntries?.filter(e => e.vehicle_number).length || 0;
        
        const { data: residentsWithVehicles } = await supabase
            .from('apartment_residents')
            .select('vehicle_number')
            .eq('apartment_id', apartmentId)
            .not('vehicle_number', 'is', null)
            .not('vehicle_number', 'eq', '');
        
        res.json({
            success: true,
            stats: {
                totalResidents: totalResidents || 0,
                activeGuards: activeGuards || 0,
                visitorsInside,
                vehiclesInside,
                totalVehicles: residentsWithVehicles?.length || 0
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get trends
app.get('/api/admin/:apartmentId/trends', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const days = parseInt(req.query.days) || 7;
        
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        const { data: logs } = await supabase
            .from('apartment_entry_logs')
            .select('entry_time')
            .eq('apartment_id', apartmentId)
            .gte('entry_time', startDate.toISOString());
        
        const trends = {};
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            trends[date.toISOString().split('T')[0]] = 0;
        }
        
        logs?.forEach(log => {
            const dateStr = new Date(log.entry_time).toISOString().split('T')[0];
            if (trends[dateStr] !== undefined) trends[dateStr]++;
        });
        
        res.json({ success: true, trends });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get entry methods
app.get('/api/admin/:apartmentId/entry-methods', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data: logs } = await supabase
            .from('apartment_entry_logs')
            .select('entry_method')
            .eq('apartment_id', apartmentId);
        
        const methods = { qr: 0, vehicle: 0, visitor_form: 0, manual: 0 };
        logs?.forEach(log => {
            if (log.entry_method === 'qr') methods.qr++;
            else if (log.entry_method === 'vehicle') methods.vehicle++;
            else if (log.entry_method === 'visitor_form') methods.visitor_form++;
            else methods.manual++;
        });
        
        res.json({ success: true, methods });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get recent activity
app.get('/api/admin/:apartmentId/recent-activity', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        
        const { data: logs } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .gte('entry_time', twentyFourHoursAgo)
            .order('entry_time', { ascending: false })
            .limit(20);
        
        res.json({ success: true, logs: logs || [] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get guards
app.get('/api/admin/:apartmentId/guards', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data: guards } = await supabase
            .from('apartment_guards')
            .select('*')
            .eq('apartment_id', apartmentId)
            .order('created_at', { ascending: false });
        
        res.json({ success: true, guards: guards || [] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create guard
app.post('/api/admin/:apartmentId/guards', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { name, email, phone, shift, password } = req.body;
        
        // Create user in Supabase Auth
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        
        if (authError) throw authError;
        
        // Add to apartment_guards
        const { error: guardError } = await supabase
            .from('apartment_guards')
            .insert({
                id: authUser.user.id,
                apartment_id: apartmentId,
                name, email, phone, shift,
                is_active: true
            });
        
        if (guardError) throw guardError;
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete guard
app.delete('/api/admin/:apartmentId/guards/:guardId', async (req, res) => {
    try {
        const { guardId } = req.params;
        
        await supabase
            .from('apartment_guards')
            .update({ is_active: false })
            .eq('id', guardId);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get residents
app.get('/api/admin/:apartmentId/residents', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data: residents } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('apartment_id', apartmentId)
            .eq('is_active', true)
            .order('flat_number');
        
        res.json({ success: true, residents: residents || [] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create resident
app.post('/api/admin/:apartmentId/residents', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const { flat_number, name, phone, email, vehicle_number } = req.body;
        
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .insert({
                apartment_id: apartmentId,
                flat_number, name, phone, email, vehicle_number,
                is_active: true
            })
            .select()
            .single();
        
        if (error) throw error;
        
        // Generate QR code
        const qrData = `RES:${resident.id}:${resident.flat_number}`;
        const qrBuffer = await QRCode.toBuffer(qrData, { width: 500, margin: 2 });
        const qrBase64 = qrBuffer.toString('base64');
        const qrImageUrl = `data:image/png;base64,${qrBase64}`;
        
        await supabase
            .from('apartment_residents')
            .update({ qr_code_value: qrData, qr_code_url: qrImageUrl })
            .eq('id', resident.id);
        
        res.json({ success: true, resident: { ...resident, qr_code_url: qrImageUrl } });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete resident
app.delete('/api/admin/:apartmentId/residents/:residentId', async (req, res) => {
    try {
        const { residentId } = req.params;
        
        await supabase
            .from('apartment_residents')
            .update({ is_active: false })
            .eq('id', residentId);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Generate QR for resident
app.post('/api/admin/:apartmentId/residents/:residentId/generate-qr', async (req, res) => {
    try {
        const { residentId } = req.params;
        
        const { data: resident, error } = await supabase
            .from('apartment_residents')
            .select('*')
            .eq('id', residentId)
            .single();
        
        if (error) throw error;
        
        const qrData = `RES:${resident.id}:${resident.flat_number}`;
        const qrBuffer = await QRCode.toBuffer(qrData, { width: 500, margin: 2 });
        const qrBase64 = qrBuffer.toString('base64');
        const qrImageUrl = `data:image/png;base64,${qrBase64}`;
        
        await supabase
            .from('apartment_residents')
            .update({ qr_code_value: qrData, qr_code_url: qrImageUrl })
            .eq('id', residentId);
        
        res.json({ success: true, qr_code_url: qrImageUrl });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get logs
app.get('/api/admin/:apartmentId/logs', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const limit = parseInt(req.query.limit) || 200;
        
        const { data: logs } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .order('entry_time', { ascending: false })
            .limit(limit);
        
        res.json({ success: true, logs: logs || [] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get analytics
app.get('/api/admin/:apartmentId/analytics', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        const period = parseInt(req.query.period) || 7;
        
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - period);
        
        const { data: logs } = await supabase
            .from('apartment_entry_logs')
            .select('*')
            .eq('apartment_id', apartmentId)
            .gte('entry_time', startDate.toISOString())
            .order('entry_time', { ascending: true });
        
        res.json({ success: true, logs: logs || [] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});




// Debug endpoint - Check all vehicles in apartment
app.get('/api/debug/apartment/:apartmentId/vehicles', async (req, res) => {
    try {
        const { apartmentId } = req.params;
        
        const { data: vehicles } = await supabase
            .from('apartment_residents')
            .select('id, name, flat_number, vehicle_number, apartment_id')
            .eq('apartment_id', apartmentId)
            .not('vehicle_number', 'is', null);
        
        res.json({
            success: true,
            apartment_id: apartmentId,
            vehicles: vehicles || []
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// =====================================================
// MASTER ADMIN ENDPOINTS
// =====================================================

// Get all apartment admins for an apartment
app.get('/api/master/apartment-admins', verifyToken, async (req, res) => {
    try {
        const { apartmentId } = req.query;
        const { data, error } = await supabase
            .from('apartment_admins')
            .select('*')
            .eq('apartment_id', apartmentId);
        if (error) throw error;
        res.json({ success: true, admins: data || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create apartment admin
app.post('/api/master/apartment-admins', verifyToken, async (req, res) => {
    try {
        const { name, email, phone, password, apartmentId } = req.body;
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authError) throw authError;
        const { error: adminError } = await supabase
            .from('apartment_admins')
            .insert({
                id: authUser.user.id,
                auth_user_id: authUser.user.id,
                apartment_id: apartmentId,
                name, email, phone,
                is_active: true
            });
        if (adminError) throw adminError;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete apartment admin
app.delete('/api/master/apartment-admins/:adminId', verifyToken, async (req, res) => {
    try {
        const { adminId } = req.params;
        await supabase.from('apartment_admins').delete().eq('id', adminId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete apartment (cascade)
app.delete('/api/apartments/:apartmentId', verifyToken, async (req, res) => {
    try {
        const { apartmentId } = req.params;
        await supabase.from('apartment_residents').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartment_guards').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartment_admins').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartment_visitors').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartment_entry_logs').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartment_pending_approvals').delete().eq('apartment_id', apartmentId);
        await supabase.from('apartments').delete().eq('id', apartmentId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// =====================================================
// MASTER ADMIN AUTHENTICATION
// =====================================================

// Master admin login check
app.post('/api/master/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Authenticate with Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email, password
        });
        
        if (authError) throw authError;
        
        // Check if user is a master admin
        const { data: masterAdmin, error: masterError } = await supabase
            .from('master_admins')
            .select('*')
            .eq('auth_user_id', authData.user.id)
            .eq('is_active', true)
            .single();
        
        if (masterError || !masterAdmin) {
            await supabase.auth.signOut();
            return res.status(403).json({ success: false, error: 'Unauthorized: Master admin access only' });
        }
        
        // Update last login
        await supabase
            .from('master_admins')
            .update({ last_login: new Date() })
            .eq('id', masterAdmin.id);
        
        res.json({
            success: true,
            masterAdmin: {
                id: masterAdmin.id,
                name: masterAdmin.name,
                email: masterAdmin.email,
                role: masterAdmin.role
            }
        });
        
    } catch (error) {
        console.error('Master login error:', error);
        res.status(401).json({ success: false, error: error.message });
    }
});

// Get master admin profile
app.get('/api/master/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const { data: masterAdmin, error } = await supabase
            .from('master_admins')
            .select('*')
            .eq('auth_user_id', userId)
            .eq('is_active', true)
            .single();
        
        if (error || !masterAdmin) {
            return res.status(403).json({ success: false, error: 'Not authorized as master admin' });
        }
        
        res.json({
            success: true,
            masterAdmin: {
                id: masterAdmin.id,
                name: masterAdmin.name,
                email: masterAdmin.email,
                role: masterAdmin.role
            }
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